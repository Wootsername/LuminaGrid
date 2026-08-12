// ============================================================
// LuminaGrid — Super Admin
// ============================================================

const gateForm = document.getElementById("gateForm");
if (gateForm) {
  gateForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const pass = document.getElementById("gatePass").value;
    if (!pass) return;

    document.getElementById("gateWrap").style.display = "none";
    document.getElementById("panelWrap").style.display = "block";
  });
}

const createAdminForm = document.getElementById("createAdminForm");
if (createAdminForm) {
  createAdminForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const resultDiv = document.getElementById("createAdminResult");

    const newAdmin = {
      first_name: document.getElementById("saFirstName").value.trim(),
      last_name: document.getElementById("saLastName").value.trim(),
      email: document.getElementById("saEmail").value.trim(),
      contact_number: document.getElementById("saContact").value.trim(),
      role: "admin"
    };

    await DataService.addUser(newAdmin);
    resultDiv.textContent = `✓ Barangay Administrator account created for ${newAdmin.first_name} ${newAdmin.last_name} (${newAdmin.email})`;
    createAdminForm.reset();
  });
}
