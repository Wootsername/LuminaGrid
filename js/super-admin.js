// ============================================================
// LuminaGrid — Super Admin (Development Team)
// Separate from the LGU-facing role system entirely — this is
// not one of the three roles gated by requireRole().
// ============================================================

document.getElementById("gateForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const pass = document.getElementById("gatePass").value;
  if (!pass) {
    document.getElementById("gateError").textContent = "Passphrase required.";
    document.getElementById("gateError").style.display = "block";
    return;
  }
  document.getElementById("gateWrap").style.display = "none";
  document.getElementById("panelWrap").style.display = "block";
});

document.getElementById("createAdminForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const user = await DataService.addUser({
    first_name: document.getElementById("saFirstName").value.trim(),
    last_name: document.getElementById("saLastName").value.trim(),
    email: document.getElementById("saEmail").value.trim(),
    contact_number: document.getElementById("saContact").value.trim(),
    role: "admin"
  });
  document.getElementById("createAdminResult").textContent =
    `Administrator account created for ${user.first_name} ${user.last_name} (${user.email}).`;
  e.target.reset();
});
