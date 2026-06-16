import { API } from "apps/labelstudio/src/providers/ApiProvider";

const BINARY_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "tiff", "ico",
  "mp4", "avi", "mov", "mkv", "webm", "flv", "wmv",
  "mp3", "wav", "ogg", "flac", "aac", "wma", "m4a",
]);

// Chunk size for multipart upload. Larger chunks => far fewer parts (an 8GB file is
// ~250 parts at 32MB vs ~1600 at 5MB), which shortens total upload time and the window
// in which a backgrounded/suspended tab can stall the transfer. (We are no longer behind
// Cloudflare Tunnel, so the old 5MB constraint no longer applies.)
const CHUNK_SIZE = 32 * 1024 * 1024;

// How many parts to upload concurrently. Parallelism keeps wall-clock down, but each
// extra simultaneous connection is more load for a flaky/filtered network to drop, so
// this is kept modest (lowered 4 -> 3) to reduce burst pressure on constrained networks
// while still overlapping transfers. Peak in-flight memory is UPLOAD_CONCURRENCY * CHUNK_SIZE.
const UPLOAD_CONCURRENCY = 3;

// Multipart sessions are persisted here so an interrupted upload of the same file can
// resume (reuse upload_id + already-uploaded parts) instead of restarting from part 1.
const RESUME_STORE_PREFIX = "ls_mpu_v1:";
const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000; // ignore sessions older than this (avoids reusing a stale/expired upload_id forever)

function getExtension(name: string): string {
  return (name.split(".").pop() || "").toLowerCase();
}

function isBinaryFile(name: string): boolean {
  return BINARY_EXTENSIONS.has(getExtension(name));
}

type ProgressCallback = (fileName: string, percent: number) => void;

/**
 * Retry an async operation with exponential backoff + jitter. Retries on any thrown error.
 * Large multipart uploads used to abort entirely on a single transient network blip.
 * On flaky/filtered networks (e.g. a hospital proxy that intermittently drops requests
 * under the parallel-upload burst), short retry windows weren't enough, so backoff now
 * spans tens of seconds. Jitter (50–100% of the delay) de-synchronizes the concurrent
 * workers so their retries don't pile into a new burst.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 4,
  baseDelayMs = 1000,
  maxDelayMs = 30000,
  onError?: (attempt: number, err: unknown) => void,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      onError?.(attempt, err);
      if (attempt < retries) {
        const expo = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        const jittered = expo * (0.5 + Math.random() * 0.5);
        await new Promise((resolve) => setTimeout(resolve, jittered));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed after ${retries} attempts`);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Best-effort telemetry beacon for upload failures. Many failures (especially on
 * flaky/filtered networks) never complete a normal request, so we log them here:
 * lands in the backend container log -> Cloud Logging (query: jsonPayload.log=~"UPLOAD_TELEMETRY").
 * Never throws and never blocks the upload.
 */
function reportUploadEvent(project: APIProject, event: Record<string, unknown>): void {
  try {
    const conn = (navigator as any)?.connection || {};
    const result = API.invoke("uploadTelemetry", { pk: project.id }, {
      body: {
        ...event,
        online: typeof navigator !== "undefined" ? navigator.onLine : undefined,
        ua: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        conn: { effectiveType: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt },
      },
    });
    if (result && typeof (result as any).catch === "function") (result as any).catch(() => {});
  } catch {
    // best-effort, ignore
  }
}

type UploadedPart = { PartNumber: number; ETag: string };
type ResumeState = {
  upload_id: string;
  object_key: string;
  chunk_size: number;
  created_at: number;
  parts: UploadedPart[];
  // Stored so the import page can list interrupted uploads without re-reading the file.
  name: string;
  size: number;
};

// A resumable session surfaced to the UI ("you have an unfinished upload of X at N%").
export type PendingUpload = { key: string; name: string; size: number; percent: number; updatedAt: number };

// Identify a file well enough to match a resumable session across reloads.
function resumeKey(file: File): string {
  return `${RESUME_STORE_PREFIX}${file.name}:${file.size}:${file.lastModified}`;
}

function loadResume(file: File): ResumeState | null {
  try {
    const raw = localStorage.getItem(resumeKey(file));
    if (!raw) return null;
    const s = JSON.parse(raw) as ResumeState;
    // Only resume if it's the same chunking scheme and not stale (a too-old upload_id
    // may have been garbage-collected by the bucket, which would fail at complete).
    if (
      s?.upload_id &&
      s.object_key &&
      s.chunk_size === CHUNK_SIZE &&
      Array.isArray(s.parts) &&
      Date.now() - s.created_at < RESUME_MAX_AGE_MS
    ) {
      return s;
    }
  } catch {
    // ignore malformed/unavailable storage
  }
  return null;
}

function saveResume(file: File, state: Omit<ResumeState, "name" | "size">): void {
  try {
    localStorage.setItem(resumeKey(file), JSON.stringify({ ...state, name: file.name, size: file.size }));
  } catch {
    // storage full / unavailable — resume is best-effort, upload still proceeds
  }
}

function clearResume(file: File): void {
  try {
    localStorage.removeItem(resumeKey(file));
  } catch {
    // ignore
  }
}

/**
 * List interrupted multipart uploads saved in this browser (most recent first),
 * so the import page can prompt the user to re-select the file and resume.
 * Stale sessions (older than RESUME_MAX_AGE_MS) are skipped.
 */
export function listPendingUploads(): PendingUpload[] {
  const out: PendingUpload[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(RESUME_STORE_PREFIX)) continue;
      try {
        const s = JSON.parse(localStorage.getItem(key) || "") as ResumeState;
        if (!s?.upload_id || !Array.isArray(s.parts) || !s.size) continue;
        if (Date.now() - s.created_at >= RESUME_MAX_AGE_MS) continue;
        const uploaded = Math.min(s.parts.length * s.chunk_size, s.size);
        out.push({
          key,
          name: s.name || key.slice(RESUME_STORE_PREFIX.length),
          size: s.size,
          percent: Math.min(99, Math.round((uploaded / s.size) * 100)),
          updatedAt: s.created_at,
        });
      } catch {
        // skip malformed entry
      }
    }
  } catch {
    // localStorage unavailable
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Forget an interrupted upload (user dismissed it). */
export function discardPendingUpload(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * Upload a small binary file using a single presigned PUT.
 */
async function singlePresignedUpload(file: File, project: APIProject, onProgress?: ProgressCallback): Promise<string> {
  const presignRes = await API.invoke("presignUpload", { pk: project.id }, {
    body: { filename: file.name, content_type: file.type || "application/octet-stream" },
  });
  if (!presignRes || presignRes.error) throw new Error(presignRes?.error || "Failed to get presigned URL");

  await uploadWithXHR(presignRes.presigned_url, file, file.type || "application/octet-stream", (pct) => {
    onProgress?.(file.name, pct);
  });
  return presignRes.object_key;
}

/**
 * Upload a large binary file using S3 multipart upload with chunked presigned URLs.
 */
async function multipartUpload(file: File, project: APIProject, onProgress?: ProgressCallback): Promise<string> {
  const totalParts = Math.ceil(file.size / CHUNK_SIZE);

  // Resume a previous, compatible session for this exact file if one exists; otherwise init.
  let upload_id: string;
  let object_key: string;
  const done = new Map<number, string>(); // PartNumber -> ETag (parts already uploaded)

  const resumed = loadResume(file);
  if (resumed) {
    upload_id = resumed.upload_id;
    object_key = resumed.object_key;
    for (const p of resumed.parts) done.set(p.PartNumber, p.ETag);
  } else {
    const initRes = await withRetry(async () => {
      const res = await API.invoke("multipartInit", { pk: project.id }, {
        body: { filename: file.name, content_type: file.type || "application/octet-stream" },
      });
      if (!res || res.error) throw new Error(res?.error || "Failed to initiate multipart upload");
      return res;
    }, "multipart init", 4, 1000, 30000, (attempt, err) =>
      reportUploadEvent(project, {
        phase: "init",
        attempt,
        fileName: file.name,
        fileSize: file.size,
        error: errText(err),
      }),
    );
    upload_id = initRes.upload_id;
    object_key = initRes.object_key;
    saveResume(file, { upload_id, object_key, chunk_size: CHUNK_SIZE, created_at: Date.now(), parts: [] });
  }

  const sizeOfPart = (partNumber: number): number =>
    Math.min(partNumber * CHUNK_SIZE, file.size) - (partNumber - 1) * CHUNK_SIZE;

  // Aggregate progress across concurrent parts: bytes uploaded per part index.
  const partBytes = new Array(totalParts).fill(0);
  done.forEach((_etag, partNumber) => {
    partBytes[partNumber - 1] = sizeOfPart(partNumber);
  });
  const reportProgress = () => {
    const uploaded = partBytes.reduce((a, b) => a + b, 0);
    onProgress?.(file.name, Math.min(100, Math.round((uploaded / file.size) * 100)));
  };
  reportProgress();

  const persist = () => {
    const parts: UploadedPart[] = [...done.entries()].map(([PartNumber, ETag]) => ({ PartNumber, ETag }));
    saveResume(file, { upload_id, object_key, chunk_size: CHUNK_SIZE, created_at: Date.now(), parts });
  };

  // Work list: only the parts not already uploaded.
  const pending: number[] = [];
  for (let i = 0; i < totalParts; i++) {
    if (!done.has(i + 1)) pending.push(i + 1);
  }

  // Concurrency pool: a fixed number of workers pull part numbers off a shared cursor.
  // cursor++ is atomic in JS's single-threaded model, so no two workers grab the same part.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const partNumber = pending[cursor++];
      const start = (partNumber - 1) * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      // Re-presign + upload together so a stale URL or a stalled PUT both recover on retry.
      // 6 attempts (~1+2+4+8+16s of jittered backoff) so a part survives a network outage
      // of up to ~30s before the whole upload aborts — the common failure on flaky networks.
      const etag = await withRetry(
        async () => {
          const partRes = await API.invoke("multipartPresignPart", { pk: project.id }, {
            body: { object_key, upload_id, part_number: partNumber },
          });
          if (!partRes || partRes.error) {
            throw new Error(partRes?.error || `Failed to get presigned URL for part ${partNumber}`);
          }
          return await uploadWithXHR(partRes.presigned_url, chunk, "application/octet-stream", (chunkPct) => {
            partBytes[partNumber - 1] = (chunk.size * chunkPct) / 100;
            reportProgress();
          });
        },
        `part ${partNumber}`,
        6,
        1000,
        30000,
        (attempt, err) =>
          reportUploadEvent(project, {
            phase: "part",
            part: partNumber,
            attempt,
            fileName: file.name,
            fileSize: file.size,
            uploadId: upload_id,
            error: errText(err),
          }),
      );

      done.set(partNumber, etag);
      partBytes[partNumber - 1] = chunk.size;
      reportProgress();
      persist(); // checkpoint after every part so an interruption resumes from here
    }
  };

  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pending.length) }, () => worker()));

  const parts: UploadedPart[] = [...done.entries()]
    .map(([PartNumber, ETag]) => ({ PartNumber, ETag }))
    .sort((a, b) => a.PartNumber - b.PartNumber);

  try {
    await withRetry(async () => {
      const res = await API.invoke("multipartComplete", { pk: project.id }, {
        body: { object_key, upload_id, parts },
      });
      if (!res || res.error) throw new Error(res?.error || "Failed to complete multipart upload");
      return res;
    }, "multipart complete", 4, 1000, 30000, (attempt, err) =>
      reportUploadEvent(project, {
        phase: "complete",
        attempt,
        fileName: file.name,
        fileSize: file.size,
        uploadId: upload_id,
        error: errText(err),
      }),
    );
  } catch (err) {
    // Complete failing usually means the upload_id is gone/invalid — drop the saved
    // session so the next attempt starts fresh rather than resuming a dead upload forever.
    clearResume(file);
    throw err;
  }

  clearResume(file);
  return object_key;
}

/**
 * Upload data via XMLHttpRequest, returns ETag from response headers.
 */
function uploadWithXHR(url: string, data: Blob, contentType: string, onProgress?: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag") || "";
        resolve(etag);
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload network error"));
    xhr.send(data);
  });
}

/**
 * Upload a binary file directly to MinIO.
 */
async function directUploadFile(
  file: File,
  project: APIProject,
  onProgress?: ProgressCallback,
): Promise<{ file_upload_id: number; task_id: number }> {
  const object_key = file.size > CHUNK_SIZE
    ? await multipartUpload(file, project, onProgress)
    : await singlePresignedUpload(file, project, onProgress);

  onProgress?.(file.name, 100);

  const registerRes = await API.invoke("registerUpload", { pk: project.id }, {
    body: { object_key },
  });
  if (!registerRes || registerRes.error) throw new Error(registerRes?.error || "Failed to register upload");

  return registerRes;
}

/**
 * Upload FormData via XHR (standard import with progress tracking).
 */
function uploadFormDataWithXHR(
  url: string,
  formData: FormData,
  onProgress?: (pct: number) => void,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");

    // Include cookies
    xhr.withCredentials = true;

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }

    xhr.onload = () => {
      try {
        const res = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(res);
        else reject(res);
      } catch {
        if (xhr.status >= 200 && xhr.status < 300) resolve({});
        else reject(new Error(`Upload failed: ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload network error"));
    xhr.send(formData);
  });
}

export const importFiles = async ({
  files,
  body,
  project,
  onUploadStart,
  onUploadFinish,
  onProgress,
  onFinish,
  onError,
  dontCommitToProject,
}: {
  files: { name: string }[];
  body: Record<string, any> | FormData;
  project: APIProject;
  onUploadStart?: (files: { name: string }[]) => void;
  onUploadFinish?: (files: { name: string }[]) => void;
  onProgress?: (fileName: string, percent: number) => void;
  onFinish?: (response: any) => void;
  onError?: (response: any) => void;
  dontCommitToProject?: boolean;
}) => {
  onUploadStart?.(files);

  try {
    const binaryFiles: File[] = [];
    const standardFormData = body instanceof FormData ? new FormData() : null;
    const standardFiles: { name: string }[] = [];

    if (body instanceof FormData) {
      for (const [key, value] of body.entries()) {
        if (value instanceof File && isBinaryFile(value.name)) {
          binaryFiles.push(value);
        } else {
          standardFormData!.append(key, value);
          if (value instanceof File) standardFiles.push(value);
        }
      }
    }

    // Direct upload binary files to MinIO
    const directResults = [];
    for (const file of binaryFiles) {
      const result = await directUploadFile(file, project, onProgress);
      directResults.push(result);
    }

    // Standard import for non-binary files
    if (standardFiles.length > 0 || !(body instanceof FormData)) {
      const query = dontCommitToProject ? { commit_to_project: "false" } : {};

      if (body instanceof FormData && standardFiles.length > 0) {
        // Use XHR for FormData to get upload progress
        const gateway = `${window.APP_SETTINGS?.hostname || ""}/api`;
        const url = `${gateway}/projects/${project.id}/import${Object.keys(query).length ? "?commit_to_project=false" : ""}`;
        const res = await uploadFormDataWithXHR(
          url,
          standardFormData!,
          (pct) => standardFiles.forEach((f) => onProgress?.(f.name, pct)),
        );
        await onFinish?.(res);
      } else {
        // URL imports etc - use standard API call
        const contentType = body instanceof FormData ? "multipart/form-data" : "application/x-www-form-urlencoded";
        const actualBody = standardFormData && standardFiles.length > 0 ? standardFormData : body;
        const res = await API.invoke(
          "importFiles",
          { pk: project.id, ...query },
          { headers: { "Content-Type": contentType }, body: actualBody },
        );

        if (res && !res.error) {
          await onFinish?.(res);
        } else {
          onError?.(res?.response);
          onUploadFinish?.(files);
          return;
        }
      }
    } else if (directResults.length > 0) {
      const convertingJobs = directResults
        .filter((r) => r.converting_job_id)
        .map((r) => ({ job_id: r.converting_job_id, file_upload_id: r.file_upload_id }));

      await onFinish?.({
        task_count: directResults.length,
        annotation_count: 0,
        prediction_count: 0,
        file_upload_ids: directResults.map((r) => r.file_upload_id),
        converting_jobs: convertingJobs.length > 0 ? convertingJobs : undefined,
      });
    }
  } catch (e: any) {
    onError?.({ detail: e.message || "Upload failed" });
  }

  onUploadFinish?.(files);
};
