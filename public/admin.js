function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

let currentUserId = null;
let currentUsername = null;
let currentIsAdmin = false;
let currentIsStaff = false;

function withAuthQuery(path) {
  return path;
}

async function ensureAuthenticated() {
  try {
    const res = await fetch("/auth/status", { method: "GET", cache: "no-store" });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    if (data && data.authenticated) {
      currentUserId = data.userId || null;
      currentUsername = data.username || null;
      currentIsAdmin = Boolean(data.isAdmin);
      currentIsStaff = Boolean(data.isStaff);
      return true;
    }
    window.location.href = "/login";
    return false;
  } catch (_err) {
    window.location.href = "/login";
    return false;
  }
}

function allowedSessionRoles(rank) {
  if (rank === "t1") return ["listener"];
  if (rank === "t2") return ["listener", "operator"];
  return ["listener", "operator", "dispatcher"];
}

const SESSION_LABELS = { dispatcher: "Dispatcher", operator: "Operator", listener: "Listener" };

const adminStatusEl = document.getElementById("adminStatus");
const adminUserEl = document.getElementById("adminUser");
const membersListEl = document.getElementById("membersList");
const rosterListEl = document.getElementById("rosterList");
const serversListEl = document.getElementById("serversList");
const roomSelectMembersEl = document.getElementById("roomSelectMembers");
const roomSelectRosterEl = document.getElementById("roomSelectRoster");
const backBtn = document.getElementById("backBtn");
const refreshBtn = document.getElementById("refreshBtn");
const logoutBtn = document.getElementById("logoutBtn");
const serverEditorPanelEl = document.getElementById("serverEditorPanel");
const createServerPanelEl = document.getElementById("createServerPanel");
const createServerFormEl = document.getElementById("createServerForm");
const createServerNameEl = document.getElementById("createServerName");
const createServerErrorEl = document.getElementById("createServerError");

function setStatus(msg) {
  if (adminStatusEl) adminStatusEl.textContent = msg;
}

let roomsCache = [];

function selectedRoomId() {
  return roomSelectMembersEl && roomSelectMembersEl.value ? roomSelectMembersEl.value : "";
}

async function loadRooms() {
  const res = await fetch(withAuthQuery("/api/rooms"), { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load servers");
  const data = await res.json();
  roomsCache = Array.isArray(data.rooms) ? data.rooms : [];

  const options = roomsCache.map(room => `<option value="${escapeHtml(room.id)}">${escapeHtml(room.name || room.id)}</option>`).join("");
  if (roomSelectMembersEl) roomSelectMembersEl.innerHTML = options;
  if (roomSelectRosterEl) roomSelectRosterEl.innerHTML = options;

  if (roomSelectMembersEl && roomSelectMembersEl.options.length > 0 && !roomSelectMembersEl.value) {
    roomSelectMembersEl.selectedIndex = 0;
  }
  if (roomSelectRosterEl && roomSelectMembersEl) {
    roomSelectRosterEl.value = roomSelectMembersEl.value;
  }
}

async function loadMembers(roomId) {
  if (!membersListEl || !roomId) return;
  membersListEl.innerHTML = '<div class="loading">Loading...</div>';

  const r = await fetch(withAuthQuery(`/api/rooms/${roomId}/members`), { method: "GET", cache: "no-store" });
  if (!r.ok) {
    membersListEl.innerHTML = '<div class="error">Access denied or failed to load members</div>';
    return;
  }
  const data = await r.json();
  const members = Array.isArray(data.members) ? data.members : [];
  if (members.length === 0) {
    membersListEl.innerHTML = '<div class="empty-state">No members online</div>';
    return;
  }

  membersListEl.innerHTML = members.map(member => {
    const allowed = allowedSessionRoles(member.rank || "t1");
    const isSelf = member.id === currentUserId;
    return `
      <div class="admin-item">
        <div>
          <div><strong>${escapeHtml(member.name)}</strong>${isSelf ? " (You)" : ""}</div>
          <div style="font-size:0.8rem;color:#a8b8c8;">Rank: ${escapeHtml(member.rank || "t1")}</div>
        </div>
        <div class="admin-item-actions">
          <select class="admin-select member-role-select" data-member-id="${escapeHtml(member.id)}">
            ${allowed.map(role => `<option value="${role}" ${member.role === role ? "selected" : ""}>${SESSION_LABELS[role] || role}</option>`).join("")}
          </select>
          ${isSelf ? "" : `<button class="admin-btn danger btn-kick" data-member-id="${escapeHtml(member.id)}">Kick</button>`}
        </div>
      </div>
    `;
  }).join("");

  membersListEl.querySelectorAll(".member-role-select").forEach(select => {
    select.addEventListener("change", async (e) => {
      const memberId = e.target.dataset.memberId;
      const role = e.target.value;
      const rr = await fetch(withAuthQuery(`/api/rooms/${roomId}/members/${memberId}/role`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role })
      });
      if (!rr.ok) {
        setStatus("Failed to update session role");
        await loadMembers(roomId);
        return;
      }
      setStatus("Session role updated");
    });
  });

  membersListEl.querySelectorAll(".btn-kick").forEach(btn => {
    btn.addEventListener("click", async () => {
      const memberId = btn.dataset.memberId;
      if (!confirm("Kick this user?")) return;
      const rr = await fetch(withAuthQuery(`/api/rooms/${roomId}/members/${memberId}/kick`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      if (!rr.ok) {
        setStatus("Failed to kick user");
        return;
      }
      setStatus("User kicked");
      await loadMembers(roomId);
    });
  });
}

async function loadRoster(roomId) {
  if (!rosterListEl || !roomId) return;
  rosterListEl.innerHTML = '<div class="loading">Loading...</div>';

  const r = await fetch(withAuthQuery(`/api/rooms/${roomId}/roster`), { method: "GET", cache: "no-store" });
  if (!r.ok) {
    rosterListEl.innerHTML = '<div class="error">Access denied or failed to load roster</div>';
    return;
  }

  const data = await r.json();
  const roster = Array.isArray(data.roster) ? data.roster : [];
  if (roster.length === 0) {
    rosterListEl.innerHTML = '<div class="empty-state">No saved roles</div>';
    return;
  }

  rosterListEl.innerHTML = roster.map(entry => `
    <div class="admin-item">
      <div>
        <div><strong>${escapeHtml(entry.username)}</strong>${entry.userId === currentUserId ? " (You)" : ""}</div>
        <div style="font-size:0.8rem;color:#a8b8c8;">${entry.online ? "Online" : "Offline"}</div>
      </div>
      <div class="admin-item-actions">
        ${entry.userId === currentUserId ? "" : `
          <select class="admin-select roster-role-select" data-user-id="${escapeHtml(entry.userId)}">
            <option value="t1" ${entry.rank === "t1" ? "selected" : ""}>T1</option>
            <option value="t2" ${entry.rank === "t2" ? "selected" : ""}>T2</option>
            <option value="t3" ${entry.rank === "t3" ? "selected" : ""}>T3</option>
            <option value="mod" ${entry.rank === "mod" ? "selected" : ""}>Moderator</option>
          </select>
        `}
      </div>
    </div>
  `).join("");

  rosterListEl.querySelectorAll(".roster-role-select").forEach(select => {
    select.addEventListener("change", async (e) => {
      const userId = e.target.dataset.userId;
      const role = e.target.value;
      const rr = await fetch(withAuthQuery(`/api/rooms/${roomId}/roster/${userId}/role`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role })
      });
      if (!rr.ok) {
        setStatus("Failed to update rank");
        await loadRoster(roomId);
        return;
      }
      setStatus("Rank updated");
    });
  });
}

async function loadServersEditor() {
  if (!currentIsAdmin) {
    if (serverEditorPanelEl) serverEditorPanelEl.hidden = true;
    return;
  }
  if (serverEditorPanelEl) serverEditorPanelEl.hidden = false;
  if (!serversListEl) return;
  serversListEl.innerHTML = '<div class="loading">Loading servers...</div>';

  if (!roomsCache.length) {
    serversListEl.innerHTML = '<div class="empty-state">No servers found</div>';
    return;
  }

  serversListEl.innerHTML = roomsCache.map(room => `
    <div class="admin-item">
      <div>
        <div><strong>${escapeHtml(room.name || "Untitled Server")}</strong></div>
        <div style="font-size:0.8rem;color:#a8b8c8;">ID: ${escapeHtml(room.id)}</div>
      </div>
      <div class="admin-item-actions inline">
        <input class="admin-input server-name-input" data-room-id="${escapeHtml(room.id)}" value="${escapeHtml(room.name || "")}" maxlength="80" />
        <button class="admin-btn btn-rename" data-room-id="${escapeHtml(room.id)}">Rename</button>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;color:#c8d6e4;">
          <input type="checkbox" class="server-open-toggle" data-room-id="${escapeHtml(room.id)}" ${room.allowAnyone ? "checked" : ""} />
          Anyone can join
        </label>
        <button class="admin-btn btn-save-access" data-room-id="${escapeHtml(room.id)}">Save Access</button>
        <button class="admin-btn danger btn-delete" data-room-id="${escapeHtml(room.id)}">Delete</button>
      </div>
    </div>
  `).join("");

  serversListEl.querySelectorAll(".btn-rename").forEach(btn => {
    btn.addEventListener("click", async () => {
      const roomId = btn.dataset.roomId;
      const input = serversListEl.querySelector(`.server-name-input[data-room-id="${roomId}"]`);
      const name = input ? input.value.trim() : "";
      if (!name) {
        setStatus("Server name cannot be empty");
        return;
      }
      const r = await fetch(withAuthQuery(`/api/rooms/${roomId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        setStatus(err.error || "Failed to rename server");
        return;
      }
      setStatus("Server renamed");
      await reloadAll();
    });
  });

  serversListEl.querySelectorAll(".btn-delete").forEach(btn => {
    btn.addEventListener("click", async () => {
      const roomId = btn.dataset.roomId;
      if (!confirm("Delete this server? All users in it will disconnect.")) return;
      const r = await fetch(withAuthQuery(`/api/rooms/${roomId}`), { method: "DELETE" });
      if (!r.ok) {
        setStatus("Failed to delete server");
        return;
      }
      setStatus("Server deleted");
      await reloadAll();
    });
  });

  serversListEl.querySelectorAll(".btn-save-access").forEach(btn => {
    btn.addEventListener("click", async () => {
      const roomId = btn.dataset.roomId;
      const toggle = serversListEl.querySelector(`.server-open-toggle[data-room-id="${roomId}"]`);
      const allowAnyone = Boolean(toggle && toggle.checked);
      const r = await fetch(withAuthQuery(`/api/rooms/${roomId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowAnyone })
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        setStatus(err.error || "Failed to update join access");
        return;
      }
      setStatus(allowAnyone ? "Anyone-can-join enabled" : "Anyone-can-join disabled");
      await reloadAll();
    });
  });
}

async function reloadAll() {
  try {
    await loadRooms();
    const roomId = selectedRoomId();
    const tasks = [
      loadMembers(roomId),
      loadRoster(roomId)
    ];
    if (currentIsAdmin) tasks.push(loadServersEditor());
    await Promise.all(tasks);
    setStatus("Loaded");
  } catch (err) {
    setStatus(err && err.message ? err.message : "Failed to load admin page");
  }
}

if (roomSelectMembersEl) {
  roomSelectMembersEl.addEventListener("change", async () => {
    if (roomSelectRosterEl) roomSelectRosterEl.value = roomSelectMembersEl.value;
    await loadMembers(roomSelectMembersEl.value);
    await loadRoster(roomSelectMembersEl.value);
  });
}

if (roomSelectRosterEl) {
  roomSelectRosterEl.addEventListener("change", async () => {
    if (roomSelectMembersEl) roomSelectMembersEl.value = roomSelectRosterEl.value;
    await loadMembers(roomSelectRosterEl.value);
    await loadRoster(roomSelectRosterEl.value);
  });
}

if (refreshBtn) {
  refreshBtn.addEventListener("click", reloadAll);
}

if (backBtn) {
  backBtn.addEventListener("click", () => {
    window.location.href = "/";
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    try {
      await fetch("/auth/logout", { method: "POST" });
    } catch (_err) {
      // Ignore logout request failures and redirect anyway.
    }
    window.location.href = "/login";
  });
}

if (createServerFormEl) {
  createServerFormEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentIsAdmin) {
      if (createServerErrorEl) createServerErrorEl.textContent = "Only admins can create servers.";
      return;
    }

    const roomName = createServerNameEl ? createServerNameEl.value.trim() : "";
    if (!roomName) {
      if (createServerErrorEl) createServerErrorEl.textContent = "Server name is required.";
      return;
    }

    if (createServerErrorEl) createServerErrorEl.textContent = "";

    try {
      const res = await fetch(withAuthQuery("/api/rooms"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (createServerErrorEl) createServerErrorEl.textContent = err.error || err.message || "Failed to create server";
        return;
      }

      if (createServerNameEl) createServerNameEl.value = "";
      setStatus("Server created");
      await reloadAll();
    } catch (_err) {
      if (createServerErrorEl) createServerErrorEl.textContent = "Error creating server";
    }
  });
}

(async () => {
  const authed = await ensureAuthenticated();
  if (!authed) return;

  if (!currentIsStaff) {
    window.location.href = "/";
    return;
  }

  if (adminUserEl) {
    adminUserEl.textContent = `Signed in as ${currentUsername || "unknown"}`;
  }

  if (createServerPanelEl) {
    createServerPanelEl.hidden = !currentIsAdmin;
  }

  await reloadAll();
})();
