// ============================================================
// LuminaGrid — User Management (Admin only)
// Use Case: "Manage User Accounts" (Barangay/LGU Administrator)
//
// NOTE: DataService.addUser() only writes the profile record
// (name, role, contact). It does NOT create a sign-in credential.
// When Firebase is wired in, pair this with a Cloud Function that
// creates the Firebase Auth user server-side and emails them a
// setup link — creating other people's login credentials directly
// from the client is not something to ship as-is.
// ============================================================

requireRole(["admin"]);
paintUserChip();
wireLogout();

async function renderUsers() {
  const users = await DataService.getUsers();
  const body = document.getElementById("userTableBody");
  body.innerHTML = users
    .map(
      (u) => `
      <tr>
        <td>${u.first_name} ${u.last_name}</td>
        <td>${u.email}</td>
        <td><span class="role-badge">${roleLabel(u.role)}</span></td>
        <td>${u.contact_number || "—"}</td>
        <td>${formatDateTime(u.created_at)}</td>
        <td>
          ${u.role === "admin" ? "" : `<button class="link-btn danger" onclick="deactivate('${u.user_id}')">Deactivate</button>`}
        </td>
      </tr>`
    )
    .join("");
}

async function deactivate(userId) {
  if (!confirm("Deactivate this account?")) return;
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
