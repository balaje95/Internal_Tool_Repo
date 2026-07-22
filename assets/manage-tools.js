// Renders the "+ Add Tool" tile and drives its modal.
// Add submits to /api/add-tool (new file + new tools.config.js entry).
// It is a Vercel serverless function that commits straight to GitHub — it has
// nothing to talk to when this page is opened as a plain static file or local server.
(function () {
  // Vercel serverless functions cap request bodies at ~4.5MB, and base64 encoding
  // adds ~33% overhead on top of the raw file size — so the safe raw-file ceiling
  // is well under that. Files above this either fail with an opaque platform error
  // or (per Vercel's ~4.5MB response error page) never reach our error handling at all.
  const MAX_FILE_BYTES = 3 * 1024 * 1024; // 3MB

  function formatBytes(bytes) {
    return (bytes / (1024 * 1024)).toFixed(2) + "MB";
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",").pop());
      reader.onerror = () => reject(new Error("Could not read the selected file."));
      reader.readAsDataURL(file);
    });
  }

  async function postJson(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      throw new Error(`No response from ${url} — this only works when deployed on Vercel with the function configured.`);
    }
    if (!res.ok) {
      throw new Error(data.error || "Something went wrong.");
    }
    return data;
  }

  // ---- Add Tool ----
  (function setupAddTool() {
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
      submitBtn.disabled = false;
      overlay.hidden = false;
    }
    function closeModal() {
      overlay.hidden = true;
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
      const help = (document.getElementById("at-help") ? document.getElementById("at-help").value : "").trim();
      const icon = document.getElementById("at-icon").value.trim();
      const password = document.getElementById("at-password").value;
      const file = document.getElementById("at-file").files[0];

      if (!file) {
        errorEl.textContent = "Please choose an .html file.";
        errorEl.hidden = false;
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        errorEl.textContent = `That file is ${formatBytes(file.size)}, which is over the ${formatBytes(MAX_FILE_BYTES)} limit for this upload form. Add it via git instead (see the dashboard repo's tools/ folder).`;
        errorEl.hidden = false;
        return;
      }

      submitBtn.disabled = true;
      statusEl.textContent = "Uploading and committing to GitHub…";
      statusEl.hidden = false;

      try {
        const fileContent = await readFileAsBase64(file);
        await postJson("/api/add-tool", { name, description, help, icon, password, filename: file.name, fileContent });
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
})();
