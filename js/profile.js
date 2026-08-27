// ============================================================
// LuminaGrid — My Profile (view & update own account)
// ------------------------------------------------------------
// Shared module for every authenticated role (Electrician,
// Finance Officer, Admin).
//
// Clicking the round initials / name in the sidebar user-chip
// opens a profile modal where the signed-in user can VIEW and
// UPDATE their first name, last name and contact number. The
// email is the login identifier and role is assigned by the
// Admin, so those fields are shown read-only.
//
// Reads/writes go through DataService only, so when Firebase is
// wired in this file does not need to change.
// ============================================================

(function () {
  const MODAL_ID = "profileModal";

  const PROFILE_MODAL_HTML = `
    <div class="modal-backdrop" id="${MODAL_ID}" role="dialog" aria-modal="true" aria-labelledby="profileModalTitle">
      <div class="card" style="max-width:460px; width:100%;">
        <div class="profile-modal-header">
          <h2 id="profileModalTitle">My Profile</h2>
          <button class="modal-close" id="profileModalClose" type="button" aria-label="Close profile">&times;</button>
        </div>

        <div class="profile-modal-avatar-wrap">
          <span class="profile-modal-avatar" id="profileModalAvatar" aria-hidden="true">—</span>
        </div>

        <form id="profileForm" novalidate>
          <div class="field">
            <label for="profileFirstName">First Name</label>
            <input type="text" id="profileFirstName" required class="no-icon" autocomplete="given-name">
          </div>
          <div class="field">
            <label for="profileLastName">Last Name</label>
            <input type="text" id="profileLastName" required class="no-icon" autocomplete="family-name">
          </div>
          <div class="field">
            <label for="profileEmail">Email (login ID)</label>
            <input type="email" id="profileEmail" readonly class="no-icon">
          </div>
          <div class="field">
            <label for="profileContact">Contact Number</label>
            <input type="text" id="profileContact" class="no-icon" placeholder="0917-000-0000" autocomplete="tel">
          </div>

          <div class="profile-meta">
            <span class="role-badge" id="profileRole">—</span>
            <span id="profileMeta">—</span>
          </div>

          <div class="profile-message" id="profileMessage" aria-live="polite"></div>

          <div style="display:flex; gap:10px; margin-top:16px;">
            <button type="button" class="btn btn-secondary" id="profileCancelBtn">Cancel</button>
            <button type="submit" class="btn btn-amber" id="profileSaveBtn">Save Changes</button>
          </div>
        </form>
      </div>
    </div>`;
const $ = (id) => document.getElementById(id);

  function ensureModal() {
    if ($(MODAL_ID)) return $(MODAL_ID);
    document.body.insertAdjacentHTML("beforeend", PROFILE_MODAL_HTML);
    return $(MODAL_ID);
  }

  function setMessage(text, type) {
    const msg = $("profileMessage");
    if (!msg) return;
    if (!text) {
      // Empty text hides the box until there is real feedback.
      msg.textContent = "";
      msg.className = "profile-message";
      return;
    }
    msg.textContent = text;
    msg.className = "profile-message " + (type || "info");
  }

  function formatProfile(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-PH", { month: "short", year: "numeric" });
  }

  async function openProfile() {
    const modal = ensureModal();
    const userId = sessionStorage.getItem("luminagrid_user_id");
    if (!userId) {
      alert("No active user session. Please log in again.");
      return;
    }

    let user = null;
    try {
      user = await DataService.getUserById(userId);
    } catch (err) {
      user = null;
    }

    if (!user) {
      setMessage("Profile record not found for this account.", "error");
      modal.classList.add("open");
      return;
    }

    const fullName = (user.first_name || "") + " " + (user.last_name || "");
    $("profileModalAvatar").textContent = formatInitials(fullName);
    $("profileFirstName").value = user.first_name || "";
    $("profileLastName").value = user.last_name || "";
    $("profileEmail").value = user.email || "";
    $("profileContact").value = user.contact_number || "";
    $("profileRole").textContent = roleLabel(user.role);
    $("profileMeta").textContent =
      `${user.user_id}  ·  Joined ${formatProfile(user.created_at)}  ·  ${user.status || "Active"}`;

    setMessage("", "info");
    modal.classList.add("open");
    const firstInput = $("profileFirstName");
    if (firstInput) firstInput.focus();
  }
  window.openProfileModal = openProfile;

  function closeProfile() {
    const modal = $(MODAL_ID);
    if (modal) modal.classList.remove("open");
  }

  function wireOpeners() {
    // The round initials avatar in the sidebar is the click target.
    document.querySelectorAll(".user-avatar").forEach((el) => {
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.style.cursor = "pointer";
      el.title = "View / Update profile";
      el.addEventListener("click", openProfile);
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openProfile();
        }
      });
    });

    // Clicking the user's name also opens the profile.
    const nameEl = $("userName");
    if (nameEl) {
      nameEl.style.cursor = "pointer";
      nameEl.addEventListener("click", openProfile);
    }
  }

  function wireModal(modal) {
    modal.addEventListener("click", (ev) => {
      if (ev.target === modal) closeProfile();
    });
    $("profileModalClose").addEventListener("click", closeProfile);
    $("profileCancelBtn").addEventListener("click", closeProfile);
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && modal.classList.contains("open")) closeProfile();
    });

    $("profileForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const userId = sessionStorage.getItem("luminagrid_user_id");
      if (!userId) return;

      const first = $("profileFirstName").value.trim();
      const last = $("profileLastName").value.trim();
      if (!first || !last) {
        setMessage("First and last name are required.", "error");
        return;
      }

      const saveBtn = $("profileSaveBtn");
      saveBtn.disabled = true;
      try {
        await DataService.updateUser(userId, {
          first_name: first,
          last_name: last,
          contact_number: $("profileContact").value.trim()
        });

        // Keep the sidebar chip and name in sync immediately.
        const fullName = first + " " + last;
        sessionStorage.setItem("luminagrid_name", fullName);
        sessionStorage.setItem("luminagrid_initials", formatInitials(fullName));
        paintUserChip();
        $("profileModalAvatar").textContent = formatInitials(fullName);

        setMessage("Profile updated successfully.", "success");
        setTimeout(closeProfile, 900);
      } catch (err) {
        setMessage("Could not save your profile. Please try again.", "error");
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  function init() {
    const modal = ensureModal();
    wireOpeners();
    wireModal(modal);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();