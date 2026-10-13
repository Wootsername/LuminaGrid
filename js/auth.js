// ============================================================
// LuminaGrid — Login (index.html)
// Authenticates with Firebase Authentication
// (auth.signInWithEmailAndPassword) and then resolves the matching
// LuminaGrid profile from the Firebase /user node (auth_uid first,
// authenticated email as fallback). The profile's role/status drive
// the existing session + role-based redirect logic below.
//
// The password is checked ONLY by Firebase Authentication — it is
// never compared against mock-nodes.json and never stored in
// localStorage/sessionStorage or Realtime Database.
//
// No registration flow here: per the Use Case Diagram, account
// creation is administrative -- the Admin manages user accounts
// (electrician / finance) and the Super Admin creates the
// Barangay/LGU Administrator account. See user-management.html
// and super-admin.html.
// ============================================================

// Password visibility toggle
const toggleBtn = document.getElementById("togglePassword");
if (toggleBtn) {
  toggleBtn.addEventListener("click", () => {
    const pwInput = document.getElementById("loginPassword");
    const isHidden = pwInput.type === "password";
    pwInput.type = isHidden ? "text" : "password";
    toggleBtn.textContent = isHidden ? "🙈" : "👁";
  });
}

// Forgot password -> Firebase Authentication's email-based password reset.
// This client-only architecture has no OTP backend, so the previously
// inert link now sends Firebase's own reset email to the address typed
// in the Username field above.
const forgotLink = document.querySelector(".forgot-link");
if (forgotLink) {
  forgotLink.addEventListener("click", async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById("loginEmail");
    const target = emailInput ? emailInput.value.trim() : "";
    if (!target) {
      alert("Enter your registered email in the field above first, then click \"forgot password?\".");
      return;
    }
    try {
      await auth.sendPasswordResetEmail(target);
      alert("Password reset email sent to " + target + ". Please check your inbox.");
    } catch (_) {
      // Generic message — do not reveal whether the address is registered.
      alert("Could not send the password reset email. Please check the email address and try again.");
    }
  });
}

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
      // 1) Real Firebase Authentication — credentials are verified by
      //    Firebase, not by any local/mock password comparison.
      const credential = await auth.signInWithEmailAndPassword(email, password);

      // 2) Resolve the LuminaGrid profile. Step 13 revision: authz-first —
      //    auth.uid -> authz/{auth.uid} -> logical user_id -> user/{user_id},
      //    which works under the hardened candidate rules without a whole-/user
      //    scan. The legacy auth_uid / email lookups remain as transition
      //    fallbacks so bootstrap compatibility is preserved while the
      //    permissive rules are still published (they become unreachable for
      //    normal accounts once every profile has authz).
      let user = null;
      try {
        const authzEntry = await DataService.getAuthz(credential.user.uid);
        if (authzEntry && authzEntry.user_id) {
          user = await DataService.getUserById(authzEntry.user_id);
        }
      } catch (_) {
        // authz missing/Deactivated under hardened rules — try fallbacks.
      }
      if (!user) {
        try {
          user = await DataService.getUserByAuthUid(credential.user.uid);
        } catch (_) { /* whole-/user scan denied — fall through */ }
      }
      if (!user && credential.user.email) {
        try {
          user = await DataService.getUserByEmail(credential.user.email);
        } catch (_) { /* denied — fall through */ }
        // First sign-in for a pre-existing profile: persist the auth_uid
        // link so future logins resolve by uid directly. Transition-only —
        // post-bootstrap profiles already carry auth_uid (write is denied
        // by hardened rules; the catch keeps login non-fatal either way).
        if (user && !user.auth_uid) {
          try {
            await DataService.setAuthUid(user.user_id, credential.user.uid);
          } catch (_) { /* non-fatal — email fallback still resolves it */ }
        }
      }

      // 3) No LuminaGrid profile for this Auth account: sign the Firebase
      //    user back out and reject access.
      if (!user) {
        await auth.signOut();
        throw new Error("no-profile");
      }

      // 4) Deactivated profile: sign the Firebase user back out and reject.
      if (String(user.status) !== "Active") {
        await auth.signOut();
        throw new Error("inactive");
      }

      const fullName = user.first_name + " " + user.last_name;
      const initials = fullName.toLowerCase() === "juan dela cruz"
        ? "JDL"
        : fullName.split(/\s+/).filter(Boolean).slice(0, 3).map(part => part.charAt(0).toUpperCase()).join("");

      // sessionStorage stays as UI convenience only (role/name chips) —
      // Firebase Auth is the actual authentication source.
      sessionStorage.setItem("luminagrid_role", user.role);
      sessionStorage.setItem("luminagrid_name", fullName);
      sessionStorage.setItem("luminagrid_initials", initials);
      sessionStorage.setItem("luminagrid_user_id", user.user_id);

      window.location.href = "dashboard.html";
    } catch (err) {
      // Preserve the existing login error behavior/box.
      if (err && err.message === "no-profile") {
        errorBox.textContent = "No LuminaGrid profile is linked to this account. Contact your administrator.";
      } else if (err && err.message === "inactive") {
        errorBox.textContent = "This account has been deactivated. Contact your administrator.";
      } else {
        errorBox.textContent = "No account found with those credentials.";
      }
      errorBox.style.display = "block";
      btn.disabled = false;
      btn.textContent = "Log-In";
    }
  });
}
