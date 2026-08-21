// ============================================================
// LuminaGrid — User Management
// Account Management (Create, Update, Deactivate, Role Mgmt)
// ============================================================

const currentRole = requireRole(["admin"]);
paintUserChip();
wireLogout();
gateNavByRole(currentRole);

async function renderUsers() {
  const users = await DataService.getUsers();
  const body = document.getElementById("userTableBody");

  body.innerHTML = users
    .map(
      (u) => `
      <tr>
        <td><strong>${u.user_id}</strong></td>
        <td>${u.first_name} ${u.last_name}</td>
        <td>${u.email}</td>
        <td><span class="role-badge" style="background:var(--gray-200); color:var(--navy-900);">${roleLabel(u.role)}</span></td>
        <td>${u.contact_number || "—"}</td>
        <td><span class="status-pill ${u.status === 'Deactivated' ? 'offline' : 'ok'}">${u.status || 'Active'}</span></td>
        <td>
          ${u.role === "admin" ? "" : `<button class="link-btn danger" onclick="deactivate('${u.user_id}')">Deactivate</button>`}
        </td>
      </tr>`
    )
    .join("");
}

async function deactivate(userId) {
  if (!confirm("Deactivate this user account?")) return;
  await DataService.deactivateUser(userId);
  renderUsers();
}
window.deactivate = deactivate;

const modal = document.getElementById("userModal");
document.getElementById("addUserBtn").addEventListener("click", () => modal.classList.add("open"));
document.getElementById("cancelUserBtn").addEventListener("click", () => modal.classList.remove("open"));

document.getElementById("userForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await DataService.addUser({
    first_name: document.getElementById("firstName").value.trim(),
    last_name: document.getElementById("lastName").value.trim(),
    email: document.getElementById("email").value.trim(),
    contact_number: document.getElementById("contactNumber").value.trim(),
    role: document.getElementById("userRoleSelect").value
  });
  modal.classList.remove("open");
  e.target.reset();
  renderUsers();
});

renderUsers();
