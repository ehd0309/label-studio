import { getRoot } from "mobx-state-tree";

const getCookie = (name) => {
  const match = document.cookie.match(new RegExp(`(^|;)\\s*${name}\\s*=\\s*([^;]+)`));
  return match ? match.pop() : "";
};

/**
 * Renderer for the "Upload filename" column: shows the (display) name plus a pencil
 * icon that lets the user rename the file's display label. Rename only changes the
 * label shown in the UI — the stored object and task data are untouched — so it's a
 * safe, instant edit. Calls the project rename-file endpoint by task id, then reloads
 * the grid so the new name shows.
 */
export const FileUpload = (cellProps) => {
  const { original, value } = cellProps;
  const name = value ?? "";

  const onRename = async (e) => {
    e.stopPropagation();
    e.preventDefault();

    const newName = window.prompt("Enter a new display name for this file:", name);
    if (!newName || newName.trim() === "" || newName === name) return;

    const match = window.location.pathname.match(/projects\/(\d+)/);
    const pk = match ? match[1] : null;
    if (!pk) return;

    try {
      const res = await fetch(`/api/projects/${pk}/rename-file`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRFToken": getCookie("csrftoken") },
        body: JSON.stringify({ task_id: original.id, new_name: newName.trim() }),
      });
      if (!res.ok) {
        window.alert("Rename failed");
        return;
      }
      const root = getRoot(original);
      if (root?.SDK?.reload) root.SDK.reload();
      else if (root?.currentView?.reload) root.currentView.reload();
      else window.location.reload();
    } catch {
      window.alert("Rename failed");
    }
  };

  if (!name) return null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, maxHeight: "100%", overflow: "hidden", fontSize: 12, lineHeight: "16px" }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      <button
        type="button"
        onClick={onRename}
        title="Rename (display name only)"
        aria-label="Rename file"
        style={{ border: "none", background: "none", cursor: "pointer", padding: 0, color: "#0891b2", flexShrink: 0, fontSize: 13, lineHeight: 1 }}
      >
        ✎
      </button>
    </div>
  );
};
