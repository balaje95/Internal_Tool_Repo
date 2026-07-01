// Renders the "+ Add Tool" tile and drives the add-tool modal.
// Submits to /api/add-tool, a Vercel serverless function that commits the new
// tool's HTML file + a new tools.config.js entry to GitHub. Only works once the
// site is deployed on Vercel with that function's environment variables set —
// it has nothing to talk to when opened as a plain static file or local server.
(function () {
  const overlay = document.getElementById("add-tool-overlay");
  const form = document.getElementById("add-tool-form");
  const errorEl = document.getElementById("at-error");
  const statusEl = document.getElementById("at-status");
  const submitBtn = document.getElementById("at-submit");
  const cancelBtn = document.getElementById("at-cancel");

  function openModal() {
    errorEl.hidden = true;
    statusEl.hidden = true;
    form.reset();
    overlay.hidden = false;
  }

  function closeModal() {
    overlay.hidden = true;
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",").pop());
      reader.onerror = () => reject(new Error("Could not read the selected file."));
      reader.readAsDataURL(file);
    });
  }

  window.renderAddToolTile = function (grid) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile tile-add";
    tile.innerHTML = `
      <div class="tile-icon">➕</div>
      <h2>Add Tool</h2>
      <p>Register a new tool on the dashboard</p>
    `;
    tile.addEventListener("click", openModal);
    grid.appendChild(tile);
  };

  cancelBtn.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    statusEl.hidden = true;

    const name = document.getElementById("at-name").value.trim();
    const description = document.getElementById("at-description").value.trim();
    const icon = document.getElementById("at-icon").value.trim();
    const password = document.getElementById("at-password").value;
    const fileInput = document.getElementById("at-file");
    const file = fileInput.files[0];

    if (!file) {
      errorEl.textContent = "Please choose an .html file.";
      errorEl.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    statusEl.textContent = "Uploading and committing to GitHub…";
    statusEl.hidden = false;

    try {
      const fileContent = await readFileAsBase64(file);
      const res = await fetch("/api/add-tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, icon, password, filename: file.name, fileContent })
      });

      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw new Error("No response from /api/add-tool — this feature only works when deployed on Vercel with the function configured.");
      }

      if (!res.ok) {
        throw new Error(data.error || "Something went wrong.");
      }

      statusEl.textContent = "Added! Vercel is redeploying now — this page will refresh in a moment.";
      setTimeout(() => window.location.reload(), 45000);
    } catch (err) {
      statusEl.hidden = true;
      errorEl.textContent = err.message || "Something went wrong.";
      errorEl.hidden = false;
      submitBtn.disabled = false;
    }
  });
})();
