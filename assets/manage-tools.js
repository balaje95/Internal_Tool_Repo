// Renders the "+ Add Tool" and "Update Tool" tiles and drives both modals.
// Add submits to /api/add-tool (new file + new tools.config.js entry).
// Update submits to /api/update-tool (overwrites an existing tool's file only).
// Both are Vercel serverless functions that commit straight to GitHub — they have
// nothing to talk to when this page is opened as a plain static file or local server.
(function () {
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
      const icon = document.getElementById("at-icon").value.trim();
      const password = document.getElementById("at-password").value;
      const file = document.getElementById("at-file").files[0];

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
        await postJson("/api/add-tool", { name, description, icon, password, filename: file.name, fileContent });
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

  // ---- Update Tool ----
  (function setupUpdateTool() {
    const overlay = document.getElementById("update-tool-overlay");
    const form = document.getElementById("update-tool-form");
    const select = document.getElementById("ut-tool");
    const errorEl = document.getElementById("ut-error");
    const statusEl = document.getElementById("ut-status");
    const submitBtn = document.getElementById("ut-submit");
    const cancelBtn = document.getElementById("ut-cancel");

    function openModal() {
      errorEl.hidden = true;
      statusEl.hidden = true;
      form.reset();
      submitBtn.disabled = false;
      select.innerHTML = (window.TOOLS || [])
        .map((t) => `<option value="${t.file}">${t.name}</option>`)
        .join("");
      overlay.hidden = false;
    }
    function closeModal() {
      overlay.hidden = true;
    }

    window.renderUpdateToolTile = function (grid) {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "tile tile-add";
      tile.innerHTML = `
        <div class="tile-icon">🔄</div>
        <h2>Update Tool</h2>
        <p>Replace an existing tool's file with a newer version</p>
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

      const toolFile = select.value;
      const password = document.getElementById("ut-password").value;
      const file = document.getElementById("ut-file").files[0];

      if (!toolFile) {
        errorEl.textContent = "Please choose a tool to update.";
        errorEl.hidden = false;
        return;
      }
      if (!file) {
        errorEl.textContent = "Please choose the replacement .html file.";
        errorEl.hidden = false;
        return;
      }

      submitBtn.disabled = true;
      statusEl.textContent = "Uploading and committing to GitHub…";
      statusEl.hidden = false;

      try {
        const fileContent = await readFileAsBase64(file);
        await postJson("/api/update-tool", { toolFile, password, fileContent });
        statusEl.textContent = "Updated! Vercel is redeploying now — this page will refresh in a moment.";
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
