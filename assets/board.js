// Dashboard board: renders tool tiles with search, New/Updated badges, a help
// popover, and a "Manage" mode (admin-password gated) that enables delete and
// drag-to-reorder. Delete/reorder call serverless endpoints that commit to GitHub
// (same pattern as Add Tool), so they only take effect on the deployed site.
(function () {
  var grid = document.getElementById("dashboard-grid");
  var emptyMsg = document.getElementById("board-empty");
  var searchInput = document.getElementById("board-search");
  var manageBtn = document.getElementById("manage-toggle");

  var FLAG_DAYS = 21;                 // show a badge if updated/added within this window
  var existsCache = {};               // file -> boolean (HEAD check result)
  var managePassword = null;          // set once when entering manage mode
  var searchTerm = "";
  var dragFile = null;

  function daysSince(iso) {
    if (!iso) return Infinity;
    var t = Date.parse(iso);
    if (isNaN(t)) return Infinity;
    return (Date.now() - t) / 86400000;
  }

  function flagFor(tool) {
    if (daysSince(tool.added) <= FLAG_DAYS) return "New";
    if (daysSince(tool.updated) <= FLAG_DAYS) return "Updated";
    return null;
  }

  function fileExists(path) {
    if (path in existsCache) return Promise.resolve(existsCache[path]);
    return fetch(path, { method: "HEAD", cache: "no-store" })
      .then(function (r) { existsCache[path] = r.ok; return r.ok; })
      .catch(function () { existsCache[path] = false; return false; });
  }

  function openHelp(tool) {
    document.getElementById("help-title").textContent = tool.name || "Tool";
    document.getElementById("help-body").textContent = tool.help || tool.description || "No description available.";
    document.getElementById("help-overlay").hidden = false;
  }

  function buildTile(tool, exists) {
    var tile = document.createElement("div");
    tile.className = "tile" + (exists ? "" : " tile-disabled");
    tile.dataset.file = tool.file;

    var inner = exists ? document.createElement("a") : document.createElement("div");
    inner.className = "tile-link";
    if (exists) inner.href = tool.file;
    inner.innerHTML =
      '<div class="tile-icon">' + (tool.icon || "🔧") + '</div>' +
      '<h2></h2><p></p>' +
      (exists ? "" : '<span class="tile-badge">Not yet available</span>');
    inner.querySelector("h2").textContent = tool.name || "";
    inner.querySelector("p").textContent = tool.description || "";
    tile.appendChild(inner);

    var flag = flagFor(tool);
    if (flag) {
      var f = document.createElement("span");
      f.className = "tile-flag";
      f.textContent = flag;
      if (tool.updated) f.title = "Updated " + tool.updated;
      tile.appendChild(f);
    }

    var actions = document.createElement("div");
    actions.className = "tile-actions";
    if (tool.help) {
      var help = document.createElement("button");
      help.type = "button";
      help.className = "tile-action";
      help.textContent = "ⓘ";
      help.title = "About this tool";
      help.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openHelp(tool); });
      actions.appendChild(help);
    }
    if (managePassword) {
      var del = document.createElement("button");
      del.type = "button";
      del.className = "tile-action tile-delete";
      del.textContent = "✕";
      del.title = "Delete this tool";
      del.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); deleteTool(tool); });
      actions.appendChild(del);
    }
    if (actions.children.length) tile.appendChild(actions);

    if (managePassword) {
      tile.setAttribute("draggable", "true");
      wireDrag(tile);
    }
    return tile;
  }

  // ---- drag-to-reorder ----
  function wireDrag(tile) {
    tile.addEventListener("dragstart", function () { dragFile = tile.dataset.file; tile.classList.add("dragging"); });
    tile.addEventListener("dragend", function () { dragFile = null; tile.classList.remove("dragging"); });
    tile.addEventListener("dragover", function (e) { e.preventDefault(); tile.classList.add("drag-over"); });
    tile.addEventListener("dragleave", function () { tile.classList.remove("drag-over"); });
    tile.addEventListener("drop", function (e) {
      e.preventDefault();
      tile.classList.remove("drag-over");
      var targetFile = tile.dataset.file;
      if (!dragFile || dragFile === targetFile) return;
      reorder(dragFile, targetFile);
    });
  }

  function reorder(fromFile, toFile) {
    var from = TOOLS.findIndex(function (t) { return t.file === fromFile; });
    var to = TOOLS.findIndex(function (t) { return t.file === toFile; });
    if (from < 0 || to < 0) return;
    var moved = TOOLS.splice(from, 1)[0];
    TOOLS.splice(to, 0, moved);
    render();
    persistOrder();
  }

  function persistOrder() {
    fetch("/api/reorder-tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: TOOLS.map(function (t) { return t.file; }), password: managePassword })
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) {
      if (!r.ok) alert("Could not save new order: " + (d.error || r.status));
    }); }).catch(function (e) { alert("Could not save new order: " + e.message); });
  }

  function deleteTool(tool) {
    if (!confirm('Delete "' + tool.name + '"? This removes the tile and its file from the repo.')) return;
    fetch("/api/delete-tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolFile: tool.file, password: managePassword })
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) {
      if (!r.ok) { alert("Delete failed: " + (d.error || r.status)); return; }
      var i = TOOLS.findIndex(function (t) { return t.file === tool.file; });
      if (i >= 0) TOOLS.splice(i, 1);
      render();
      alert('Deleted "' + tool.name + '". Vercel will redeploy shortly.');
    }); }).catch(function (e) { alert("Delete failed: " + e.message); });
  }

  // ---- manage mode ----
  manageBtn.addEventListener("click", function () {
    if (managePassword) {
      managePassword = null;
      document.body.classList.remove("manage-mode");
      manageBtn.classList.remove("active");
      manageBtn.textContent = "⚙ Manage";
    } else {
      var pw = prompt("Enter the admin password to enable delete & reorder:");
      if (!pw) return;
      managePassword = pw;
      document.body.classList.add("manage-mode");
      manageBtn.classList.add("active");
      manageBtn.textContent = "✓ Done";
    }
    render();
  });

  // ---- help popover close ----
  document.getElementById("help-close").addEventListener("click", function () {
    document.getElementById("help-overlay").hidden = true;
  });
  document.getElementById("help-overlay").addEventListener("click", function (e) {
    if (e.target === this) this.hidden = true;
  });

  // ---- search ----
  if (searchInput) {
    searchInput.addEventListener("input", function () {
      searchTerm = this.value.trim().toLowerCase();
      render();
    });
  }

  function matches(tool) {
    if (!searchTerm) return true;
    return ((tool.name || "") + " " + (tool.description || "") + " " + (tool.help || ""))
      .toLowerCase().indexOf(searchTerm) >= 0;
  }

  // ---- render ----
  function render() {
    grid.innerHTML = "";
    var shown = 0;
    TOOLS.forEach(function (tool) {
      if (!matches(tool)) return;
      shown++;
      var exists = existsCache[tool.file];
      grid.appendChild(buildTile(tool, exists !== false));
    });
    // Add tile only when not filtering and not in manage mode.
    if (!searchTerm && !managePassword) {
      if (window.renderAddToolTile) window.renderAddToolTile(grid);
    }
    if (emptyMsg) emptyMsg.hidden = !(searchTerm && shown === 0);
  }

  // Initial existence checks, then render.
  Promise.all((typeof TOOLS !== "undefined" ? TOOLS : []).map(function (t) { return fileExists(t.file); }))
    .then(render);
})();
