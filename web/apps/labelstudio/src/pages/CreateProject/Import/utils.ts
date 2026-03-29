import { API } from "apps/labelstudio/src/providers/ApiProvider";

const BINARY_EXTENSIONS = new Set([
  // images
  "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "tiff", "ico",
  // video
  "mp4", "avi", "mov", "mkv", "webm", "flv", "wmv",
  // audio
  "mp3", "wav", "ogg", "flac", "aac", "wma", "m4a",
]);

function getExtension(name: string): string {
  return (name.split(".").pop() || "").toLowerCase();
}

function isBinaryFile(name: string): boolean {
  return BINARY_EXTENSIONS.has(getExtension(name));
}

async function directUploadFile(
  file: File,
  project: APIProject,
  onProgress?: (pct: number) => void,
): Promise<{ file_upload_id: number; task_id: number }> {
  // 1. Get presigned URL from backend
  const presignRes = await API.invoke("presignUpload", { pk: project.id }, {
    body: {
      filename: file.name,
      content_type: file.type || "application/octet-stream",
    },
  });

  if (!presignRes || presignRes.error) {
    throw new Error(presignRes?.error || "Failed to get presigned URL");
  }

  // 2. Upload directly to MinIO via presigned URL
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", presignRes.presigned_url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed: ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Upload network error"));
    xhr.send(file);
  });

  // 3. Register the uploaded file in Django
  const registerRes = await API.invoke("registerUpload", { pk: project.id }, {
    body: {
      object_key: presignRes.object_key,
    },
  });

  if (!registerRes || registerRes.error) {
    throw new Error(registerRes?.error || "Failed to register upload");
  }

  return registerRes;
}

export const importFiles = async ({
  files,
  body,
  project,
  onUploadStart,
  onUploadFinish,
  onFinish,
  onError,
  dontCommitToProject,
}: {
  files: { name: string }[];
  body: Record<string, any> | FormData;
  project: APIProject;
  onUploadStart?: (files: { name: string }[]) => void;
  onUploadFinish?: (files: { name: string }[]) => void;
  onFinish?: (response: any) => void;
  onError?: (response: any) => void;
  dontCommitToProject?: boolean;
}) => {
  onUploadStart?.(files);

  try {
    // Separate binary files (direct upload) from data files (standard import)
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
      const result = await directUploadFile(file, project);
      directResults.push(result);
    }

    // Standard import for non-binary files (if any)
    if (standardFiles.length > 0 || !(body instanceof FormData)) {
      const query = dontCommitToProject ? { commit_to_project: "false" } : {};
      const contentType =
        body instanceof FormData
          ? "multipart/form-data"
          : "application/x-www-form-urlencoded";

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
    } else if (directResults.length > 0) {
      // All files were binary - report success
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
