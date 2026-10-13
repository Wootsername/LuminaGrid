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
    // Step 13: the passphrase gate above is prototype UX only — real
    // authorization is the signed-in Firebase administrator session. The
    // candidate hardened rules require an active admin profile for the
    // /user + /authz writes this form performs, and no rule access is ever
    // granted based on the passphrase. Block the client-only path up front.
    const sessionRole = sessionStorage.getItem("luminagrid_role");
    const fbUser = (typeof auth !== "undefined" && auth) ? auth.currentUser : null;
    if (sessionRole !== "admin" || !fbUser) {
      alert("Sign in with an administrator account first — the passphrase gate alone does not grant account-creation access.");
      return;
    }
    const resultDiv = document.getElementById("createAdminResult");

    const newAdmin = {
      first_name: document.getElementById("saFirstName").value.trim(),
      last_name: document.getElementById("saLastName").value.trim(),
      email: document.getElementById("saEmail").value.trim(),
      contact_number: document.getElementById("saContact").value.trim(),
      role: "admin",
      // Consumed by Firebase Auth only (secondary UserCreator app) —
      // never written to the Realtime Database /user node.
      password: document.getElementById("saPassword").value
    };

    try {
      // Creates BOTH the Firebase Auth account and the /user profile on the
      // secondary app, so no currently signed-in session is replaced.
      await DataService.addUser(newAdmin);
      resultDiv.textContent = `✓ Barangay Administrator account created for ${newAdmin.first_name} ${newAdmin.last_name} (${newAdmin.email})`;
      createAdminForm.reset();
    } catch (err) {
      resultDiv.textContent = "";
      alert(err && err.message ? err.message : "Could not create the administrator account. Please try again.");
    }
  });
}
