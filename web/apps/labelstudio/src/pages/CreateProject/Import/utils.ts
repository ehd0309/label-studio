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

// How many parts to upload concurrently. Keeps wall-clock down while bounding peak
// memory/connections (UPLOAD_CONCURRENCY * CHUNK_SIZE of in-flight buffers).
const UPLOAD_CONCURRENCY = 4;

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
 * Retry an async operation with exponential backoff. Retries on any thrown error.
 * Large multipart uploads (10GB+ / 2000+ parts) used to abort entirely on a single
 * transient network blip (a stalled part, or a failed init) — this makes each step
 * resilient so one hiccup no longer discards the whole upload.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 3, baseDelayMs = 1000): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed after ${retries} attempts`);
}

type UploadedPart = { PartNumber: number; ETag: string };
type ResumeState = {
  upload_id: string;
  object_key: string;
  chunk_size: number;
  created_at: number;
  parts: UploadedPart[];
};

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

function saveResume(file: File, state: ResumeState): void {
  try {
    localStorage.setItem(resumeKey(file), JSON.stringify(state));
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
    }, "multipart init");
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
      const etag = await withRetry(async () => {
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
      }, `part ${partNumber}`);

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
    }, "multipart complete");
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
