import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Spinner, Typography } from "@humansignal/ui";
import { useUpdatePageTitle, createTitleFromSegments } from "@humansignal/core";
import { useAPI } from "../../providers/ApiProvider";
import { useProject } from "../../providers/ProjectProvider";

function formatSize(bytes) {
  if (bytes == null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function getFileType(name) {
  const ext = name?.split(".").pop()?.toLowerCase() || "";
  const types = {
    image: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "tiff", "ico"],
    video: ["mp4", "avi", "mov", "mkv", "webm", "flv", "wmv"],
    audio: ["mp3", "wav", "ogg", "flac", "aac", "wma", "m4a"],
    document: ["pdf", "doc", "docx", "txt", "csv", "json", "jsonl", "xml", "html"],
  };
  for (const [type, exts] of Object.entries(types)) {
    if (exts.includes(ext)) return type;
  }
  return "file";
}

function isWmv(name) {
  return name?.toLowerCase().endsWith(".wmv");
}

export const StorageBrowser = () => {
  const { project } = useProject();
  const api = useAPI();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [converting, setConverting] = useState({}); // {fileId: {jobId, status}}
  const pollTimers = useRef({});

  useUpdatePageTitle(createTitleFromSegments([project?.title, "Storage Browser"]));

  const fetchFiles = useCallback(async () => {
    if (!project?.id) return;
    setLoading(true);
    try {
      const result = await api.callApi("projectFilesBrowse", {
        params: { pk: project.id },
      });
      setData(result);
      setSelected(new Set());
    } catch (e) {
      console.error("Failed to fetch files", e);
    } finally {
      setLoading(false);
    }
  }, [api, project?.id]);

  useEffect(() => {
    fetchFiles();
    return () => {
      // Cleanup polling timers
      Object.values(pollTimers.current).forEach(clearInterval);
    };
  }, [fetchFiles]);

  const deleteFiles = useCallback(async (ids) => {
    if (!project?.id || ids.length === 0) return;
    const label = ids.length === 1 ? "this file and its task" : `${ids.length} files and their tasks`;
    if (!window.confirm(`Are you sure you want to delete ${label}? This cannot be undone.`)) return;

    setDeleting((prev) => {
      const next = { ...prev };
      ids.forEach((id) => (next[id] = true));
      return next;
    });
    try {
      await api.callApi("projectFilesDelete", {
        params: { pk: project.id },
        body: { file_upload_ids: ids },
      });
      await fetchFiles();
    } catch (e) {
      console.error("Failed to delete files", e);
    } finally {
      setDeleting({});
    }
  }, [api, project?.id, fetchFiles]);

  const convertToMp4 = useCallback(async (fileId) => {
    if (!project?.id) return;

    try {
      const res = await api.callApi("convertWmv", {
        params: { pk: project.id },
        body: { file_upload_ids: [fileId], delete_original: true },
      });

      if (!res?.jobs?.length) return;

      const { job_id } = res.jobs[0];
      setConverting((prev) => ({ ...prev, [fileId]: { jobId: job_id, status: "converting" } }));

      // Poll for status
      const timer = setInterval(async () => {
        try {
          const statusRes = await api.callApi("convertWmvStatus", {
            params: { pk: project.id },
            query: { job_ids: job_id },
          });
          const jobStatus = statusRes?.jobs?.[job_id];
          if (!jobStatus) return;

          if (jobStatus.status === "completed") {
            clearInterval(timer);
            delete pollTimers.current[fileId];
            setConverting((prev) => {
              const next = { ...prev };
              delete next[fileId];
              return next;
            });
            await fetchFiles();
          } else if (jobStatus.status === "failed") {
            clearInterval(timer);
            delete pollTimers.current[fileId];
            setConverting((prev) => {
              const next = { ...prev };
              delete next[fileId];
              return next;
            });
            window.alert(`Conversion failed: ${jobStatus.error || "Unknown error"}`);
          }
        } catch (e) {
          console.error("Failed to poll conversion status", e);
        }
      }, 3000);
      pollTimers.current[fileId] = timer;
    } catch (e) {
      console.error("Failed to start conversion", e);
    }
  }, [api, project?.id, fetchFiles]);

  const convertAllWmv = useCallback(async () => {
    const files = data?.files || [];
    const wmvFiles = files.filter((f) => isWmv(f.name) && !converting[f.id]);
    if (!wmvFiles.length) return;
    if (!window.confirm(`${wmvFiles.length} WMV files will be converted to MP4. Continue?`)) return;
    for (const f of wmvFiles) {
      await convertToMp4(f.id);
    }
  }, [data, converting, convertToMp4]);

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const files = data?.files || [];
    if (selected.size === files.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(files.map((f) => f.id)));
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "80px 0" }}>
        <Spinner />
      </div>
    );
  }

  const files = data?.files || [];
  const totalCount = data?.total_count || 0;
  const totalSize = data?.total_size || 0;
  const allSelected = files.length > 0 && selected.size === files.length;
  const wmvCount = files.filter((f) => isWmv(f.name)).length;

  return (
    <div style={{ padding: "0" }}>
      <div style={{ marginBottom: "24px" }}>
        <Typography variant="headline" size="small">
          Storage Browser
        </Typography>
        <Typography size="small" style={{ color: "#6b7280", marginTop: "4px" }}>
          Files uploaded to this project are stored in MinIO.
        </Typography>
      </div>

      <div
        style={{
          display: "flex",
          gap: "24px",
          marginBottom: "24px",
          padding: "16px",
          background: "#f9fafb",
          borderRadius: "8px",
          border: "1px solid #e5e7eb",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: "24px", fontWeight: 600 }}>{totalCount}</div>
          <div style={{ fontSize: "13px", color: "#6b7280" }}>Total Files</div>
        </div>
        <div>
          <div style={{ fontSize: "24px", fontWeight: 600 }}>{formatSize(totalSize)}</div>
          <div style={{ fontSize: "13px", color: "#6b7280" }}>Total Size</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
          {wmvCount > 0 && (
            <button
              onClick={convertAllWmv}
              style={{
                padding: "6px 16px",
                background: "#059669",
                color: "#fff",
                border: "none",
                borderRadius: "6px",
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              Convert all WMV ({wmvCount})
            </button>
          )}
          {selected.size > 0 && (
            <button
              onClick={() => deleteFiles([...selected])}
              style={{
                padding: "6px 16px",
                background: "#dc2626",
                color: "#fff",
                border: "none",
                borderRadius: "6px",
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              Delete {selected.size} selected
            </button>
          )}
        </div>
      </div>

      {files.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 0", color: "#9ca3af" }}>
          No files uploaded yet
        </div>
      ) : (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: "8px", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
            <thead>
              <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                <th style={{ padding: "10px 12px", width: "40px" }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    style={{ cursor: "pointer" }}
                  />
                </th>
                <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 500, color: "#6b7280" }}>Name</th>
                <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 500, color: "#6b7280", width: "80px" }}>Type</th>
                <th style={{ padding: "10px 16px", textAlign: "right", fontWeight: 500, color: "#6b7280", width: "100px" }}>Size</th>
                <th style={{ padding: "10px 16px", textAlign: "center", fontWeight: 500, color: "#6b7280", width: "220px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => {
                const conv = converting[file.id];
                return (
                  <tr
                    key={file.id}
                    style={{
                      borderBottom: "1px solid #f3f4f6",
                      background: conv ? "#f0fdf4" : selected.has(file.id) ? "#eff6ff" : "transparent",
                    }}
                  >
                    <td style={{ padding: "10px 12px" }}>
                      <input
                        type="checkbox"
                        checked={selected.has(file.id)}
                        onChange={() => toggleSelect(file.id)}
                        style={{ cursor: "pointer" }}
                      />
                    </td>
                    <td
                      style={{
                        padding: "10px 16px",
                        maxWidth: "400px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={file.name}
                    >
                      {file.name}
                    </td>
                    <td style={{ padding: "10px 16px", color: "#6b7280" }}>{getFileType(file.name)}</td>
                    <td style={{ padding: "10px 16px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {formatSize(file.size)}
                    </td>
                    <td style={{ padding: "10px 16px", textAlign: "center" }}>
                      {conv ? (
                        <span style={{ color: "#059669", fontSize: "13px" }}>
                          Converting...
                        </span>
                      ) : (
                        <>
                          {isWmv(file.name) && (
                            <button
                              onClick={() => convertToMp4(file.id)}
                              style={{
                                color: "#059669",
                                background: "none",
                                border: "none",
                                fontSize: "13px",
                                cursor: "pointer",
                                marginRight: "12px",
                              }}
                            >
                              Convert to MP4
                            </button>
                          )}
                          <a
                            href={file.url}
                            download
                            style={{ color: "#2563eb", textDecoration: "none", fontSize: "13px", marginRight: "12px" }}
                          >
                            Download
                          </a>
                          <button
                            onClick={() => deleteFiles([file.id])}
                            disabled={deleting[file.id]}
                            style={{
                              color: "#dc2626",
                              background: "none",
                              border: "none",
                              fontSize: "13px",
                              cursor: deleting[file.id] ? "not-allowed" : "pointer",
                              opacity: deleting[file.id] ? 0.5 : 1,
                            }}
                          >
                            {deleting[file.id] ? "Deleting..." : "Delete"}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

StorageBrowser.title = "Storage Browser";
StorageBrowser.path = "/storage-browser";
