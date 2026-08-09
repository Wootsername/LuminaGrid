// ============================================================
// LuminaGrid — Login (index.html)
// Authenticates against DataService (mock users right now).
// When Firebase is wired in, replace the body of the submit
// handler with auth.signInWithEmailAndPassword(...) — the
// role-based redirect logic below doesn't need to change.
//
// No registration flow here: per the Use Case Diagram, account
// creation is administrative -- the Admin manages user accounts
// (electrician / finance) and the Super Admin creates the
// Barangay/LGU Administrator account. See user-management.html
// and super-admin.html.
// ============================================================

const loginForm = document.getElementById("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const errorBox = document.getElementById("loginError");
    const btn = document.getElementById("loginBtn");

    errorBox.style.display = "none";
    btn.disabled = true;
    btn.textContent = "Signing in...";

    try {
      const user = await DataService.getUserByEmail(email);

      // Mock check only -- password field in mock-nodes.json is a
      // placeholder, so any non-empty password passes for now.
      // Swap for real Firebase Auth once accounts are provisioned there.
      if (!user || !password) {
        throw new Error("invalid");
      }

      sessionStorage.setItem("luminagrid_role", user.role);
      sessionStorage.setItem("luminagrid_name", user.first_name + " " + user.last_name);
      sessionStorage.setItem("luminagrid_user_id", user.user_id);

      window.location.href = "dashboard.html";
    } catch (err) {
      errorBox.textContent = "No account found with those credentials.";
      errorBox.style.display = "block";
      btn.disabled = false;
      btn.textContent = "Sign In";
    }
  });
}
