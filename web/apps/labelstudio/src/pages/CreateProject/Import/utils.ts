import { API } from "apps/labelstudio/src/providers/ApiProvider";

const BINARY_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "tiff", "ico",
  "mp4", "avi", "mov", "mkv", "webm", "flv", "wmv",
  "mp3", "wav", "ogg", "flac", "aac", "wma", "m4a",
]);

// Chunk size for multipart upload (80MB — safely under Cloudflare's 100MB limit)
const CHUNK_SIZE = 80 * 1024 * 1024;

function getExtension(name: string): string {
  return (name.split(".").pop() || "").toLowerCase();
}

function isBinaryFile(name: string): boolean {
  return BINARY_EXTENSIONS.has(getExtension(name));
}

type ProgressCallback = (fileName: string, percent: number) => void;

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
  const initRes = await API.invoke("multipartInit", { pk: project.id }, {
    body: { filename: file.name, content_type: file.type || "application/octet-stream" },
  });
  if (!initRes || initRes.error) throw new Error(initRes?.error || "Failed to initiate multipart upload");

  const { upload_id, object_key } = initRes;
  const totalParts = Math.ceil(file.size / CHUNK_SIZE);
  const parts: { PartNumber: number; ETag: string }[] = [];

  for (let i = 0; i < totalParts; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);
    const partNumber = i + 1;

    const partRes = await API.invoke("multipartPresignPart", { pk: project.id }, {
      body: { object_key, upload_id, part_number: partNumber },
    });
    if (!partRes || partRes.error) throw new Error(partRes?.error || `Failed to get presigned URL for part ${partNumber}`);

    const etag = await uploadWithXHR(partRes.presigned_url, chunk, "application/octet-stream", (chunkPct) => {
      // Overall progress: completed parts + current chunk progress
      const overallPct = Math.round(((i + chunkPct / 100) / totalParts) * 100);
      onProgress?.(file.name, overallPct);
    });
    parts.push({ PartNumber: partNumber, ETag: etag });
  }

  const completeRes = await API.invoke("multipartComplete", { pk: project.id }, {
    body: { object_key, upload_id, parts },
  });
  if (!completeRes || completeRes.error) throw new Error(completeRes?.error || "Failed to complete multipart upload");

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
      await onFinish?.({
        task_count: directResults.length,
        annotation_count: 0,
        prediction_count: 0,
        file_upload_ids: directResults.map((r) => r.file_upload_id),
      });
    }
  } catch (e: any) {
    onError?.({ detail: e.message || "Upload failed" });
  }

  onUploadFinish?.(files);
};
