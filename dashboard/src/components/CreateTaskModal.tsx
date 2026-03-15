import { useState } from "react";

type CreateTaskModalProps = {
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>) => void;
  agents: string[];
  isCreating?: boolean;
};

export function CreateTaskModal({
  onClose,
  onSubmit,
  agents,
  isCreating,
}: CreateTaskModalProps) {
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState("P2");
  const [description, setDescription] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      assignedTo: assignee || undefined,
      priority,
      description: description.trim() || undefined,
    });
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-cf-bg-secondary border border-cf-border rounded-lg shadow-2xl w-full max-w-[440px]">
          {/* Header */}
          <div className="px-5 py-4 border-b border-cf-border-muted flex items-center justify-between">
            <h2 className="text-sm font-semibold text-cf-text-primary">
              Create Task
            </h2>
            <button
              onClick={onClose}
              className="text-cf-text-muted hover:text-cf-text-primary transition-colors"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
            {/* Title */}
            <div>
              <label className="text-xxs text-cf-text-muted uppercase tracking-wider font-semibold block mb-1.5">
                Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title..."
                className="w-full text-xs bg-cf-bg-primary border border-cf-border rounded px-3 py-2 text-cf-text-primary placeholder:text-cf-text-muted focus:border-cf-accent-blue focus:outline-none"
                autoFocus
              />
            </div>

            {/* Description */}
            <div>
              <label className="text-xxs text-cf-text-muted uppercase tracking-wider font-semibold block mb-1.5">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Task description..."
                rows={3}
                className="w-full text-xs bg-cf-bg-primary border border-cf-border rounded px-3 py-2 text-cf-text-primary placeholder:text-cf-text-muted focus:border-cf-accent-blue focus:outline-none resize-none"
              />
            </div>

            {/* Assignee + Priority row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xxs text-cf-text-muted uppercase tracking-wider font-semibold block mb-1.5">
                  Assignee
                </label>
                <select
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  className="w-full text-xs bg-cf-bg-primary border border-cf-border rounded px-3 py-2 text-cf-text-secondary focus:border-cf-accent-blue focus:outline-none appearance-none cursor-pointer"
                >
                  <option value="">Unassigned</option>
                  {agents.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xxs text-cf-text-muted uppercase tracking-wider font-semibold block mb-1.5">
                  Priority
                </label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  className="w-full text-xs bg-cf-bg-primary border border-cf-border rounded px-3 py-2 text-cf-text-secondary focus:border-cf-accent-blue focus:outline-none appearance-none cursor-pointer"
                >
                  <option value="P0">P0 - Critical</option>
                  <option value="P1">P1 - High</option>
                  <option value="P2">P2 - Medium</option>
                  <option value="P3">P3 - Low</option>
                </select>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="text-xs font-medium px-4 py-1.5 rounded border border-cf-border text-cf-text-secondary hover:bg-cf-bg-tertiary transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!title.trim() || isCreating}
                className="text-xs font-medium px-4 py-1.5 rounded bg-cf-accent-blue text-white hover:bg-cf-accent-blue/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isCreating ? "Creating..." : "Create Task"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
