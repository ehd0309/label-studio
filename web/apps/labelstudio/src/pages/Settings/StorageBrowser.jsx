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

function formatDate(isoString) {
  if (!isoString) return "—";
  const d = new Date(isoString);
  return d.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" })
    + " " + d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

export const StorageBrowser = () => {
  const { project } = useProject();
  const api = useAPI();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [manualConverting, setManualConverting] = useState({}); // manual convert button state
  const pollTimer = useRef(null);

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
      return result;
    } catch (e) {
      console.error("Failed to fetch files", e);
    } finally {
      setLoading(false);
    }
  }, [api, project?.id]);

  // Initial fetch + auto-poll if any files are converting
  useEffect(() => {
    fetchFiles();
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [fetchFiles]);

  // Auto-poll when files are converting
  useEffect(() => {
    const hasConverting = data?.files?.some((f) => f.converting);
    if (hasConverting && !pollTimer.current) {
      pollTimer.current = setInterval(async () => {
        if (!project?.id) return;
        try {
          const result = await api.callApi("projectFilesBrowse", {
            params: { pk: project.id },
          });
          setData(result);
          // Stop polling if no more converting files
          if (!result?.files?.some((f) => f.converting)) {
            clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
        } catch (e) {
          console.error("Poll failed", e);
        }
      }, 5000);
    } else if (!hasConverting && pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, [data, api, project?.id]);

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
    setManualConverting((prev) => ({ ...prev, [fileId]: true }));
    try {
      await api.callApi("convertWmv", {
        params: { pk: project.id },
        body: { file_upload_ids: [fileId], delete_original: true },
      });
      await fetchFiles();
    } catch (e) {
      console.error("Failed to start conversion", e);
      setManualConverting((prev) => {
        const next = { ...prev };
        delete next[fileId];
        return next;
      });
    }
  }, [api, project?.id, fetchFiles]);

  const convertAllWmv = useCallback(async () => {
    const files = data?.files || [];
    const wmvFiles = files.filter((f) => isWmv(f.name) && !f.converting);
    if (!wmvFiles.length) return;
    if (!window.confirm(`${wmvFiles.length} WMV files will be converted to MP4. Continue?`)) return;
    for (const f of wmvFiles) {
      await convertToMp4(f.id);
    }
  }, [data, convertToMp4]);

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
  const wmvCount = files.filter((f) => isWmv(f.name) && !f.converting).length;
  const convertingCount = files.filter((f) => f.converting).length;

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

      {convertingCount > 0 && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 16px",
          background: "#f0fdf4",
          border: "1px solid #bbf7d0",
          borderRadius: "8px",
          marginBottom: "12px",
          fontSize: "14px",
          color: "#166534",
        }}>
          <Spinner size={16} />
          {convertingCount} file(s) converting to MP4... Tasks will be created automatically when done.
        </div>
      )}

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
                <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 500, color: "#6b7280", width: "100px" }}>Status</th>
                <th style={{ padding: "10px 16px", textAlign: "right", fontWeight: 500, color: "#6b7280", width: "100px" }}>Size</th>
                <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 500, color: "#6b7280", width: "150px" }}>Date</th>
                <th style={{ padding: "10px 16px", textAlign: "center", fontWeight: 500, color: "#6b7280", width: "220px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => {
                const isConverting = file.converting || manualConverting[file.id];
                return (
                  <tr
                    key={file.id}
                    style={{
                      borderBottom: "1px solid #f3f4f6",
                      background: isConverting ? "#f0fdf4" : selected.has(file.id) ? "#eff6ff" : "transparent",
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
                    <td style={{ padding: "10px 16px" }}>
                      {isConverting ? (
                        <span style={{ color: "#059669", fontSize: "13px", display: "flex", alignItems: "center", gap: "4px" }}>
                          <Spinner size={12} /> Converting...
                        </span>
                      ) : (
                        <span style={{ color: "#6b7280", fontSize: "13px" }}>
                          {getFileType(file.name)}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {formatSize(file.size)}
                    </td>
                    <td style={{ padding: "10px 16px", color: "#6b7280", fontSize: "13px", whiteSpace: "nowrap" }}>
                      {formatDate(file.created_at)}
                    </td>
                    <td style={{ padding: "10px 16px", textAlign: "center" }}>
                      {isConverting ? (
                        <span style={{ color: "#059669", fontSize: "13px" }}>
                          MP4 conversion in progress
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
