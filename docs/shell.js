/* Life Admin standalone shell: Google sign-in + Google Sheets/Drive, standing in for Claude's connectors.
   The app's own code calls window.claude.use("mcp").callTool(server, tool, input) exactly as it does inside Claude. */
(function(){
  var CLIENT_ID = window.LA_CLIENT_ID || "";
  var SCOPES = "openid email https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive";
  var DARREN = "https://claude.ai/artifact/37YJK3ing21Rw7bVb3PY54";
  var SHARED = "https://claude.ai/artifact/CzS2amz5zPkn7o5wCZkEPY";
  var HERE = location.origin + location.pathname;
  function ls(k,v){try{if(v===undefined)return localStorage.getItem(k);if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v)}catch(e){return null}}

  // 1. Coming back from Google with a token in the URL
  var hp = new URLSearchParams(location.hash.slice(1));
  if (hp.get("access_token")) {
    ls("la_tok", hp.get("access_token"));
    ls("la_exp", String(Date.now() + (Number(hp.get("expires_in")) || 3600) * 1000 - 60000));
    var back = hp.get("state") || "";
    history.replaceState(null, "", HERE + (back && back.charAt(0) === "#" ? back : ""));
  } else if (hp.get("error")) {
    ls("la_silent_failed", "1");
    history.replaceState(null, "", HERE);
  }

  function token(){var t=ls("la_tok"),e=Number(ls("la_exp")||0);return t&&e>Date.now()?t:null}
  function signIn(silent){
    var p = new URLSearchParams({client_id:CLIENT_ID, redirect_uri:HERE, response_type:"token", scope:SCOPES,
      include_granted_scopes:"true", state:location.hash||""});
    var em = ls("la_email");
    if (silent) { p.set("prompt","none"); if (em) p.set("login_hint", em); }
    else p.set("prompt", em ? "consent" : "select_account consent");
    location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
  }
  window.LA_signOut = function(){ls("la_tok",null);ls("la_exp",null);ls("la_email",null);location.href=HERE};

  // 2. No valid token: try a silent refresh once (no tap needed), otherwise show the sign-in screen
  if (!token()) {
    if (CLIENT_ID && ls("la_email") && !ls("la_silent_failed")) { signIn(true); return; }
    ls("la_silent_failed", null);
    document.addEventListener("DOMContentLoaded", function(){
      var s = document.createElement("div");
      s.id = "gsignin";
      s.innerHTML = '<div class="gs-in"><img src="icon-192.png" alt="" width="96" height="96"><h1>Life Admin</h1>'
        + '<p>Your renewals, bills, documents and family notes, kept in your own Google Drive.</p>'
        + (CLIENT_ID ? '<button id="gsbtn">Sign in with Google</button>' : '<p><b>Not set up yet:</b> the Google sign-in key hasn’t been added.</p>')
        + '<small>Only you can see your data. It stays in your Google account.</small></div>';
      document.body.appendChild(s);
      var b = document.getElementById("gsbtn"); if (b) b.onclick = function(){ signIn(false); };
    });
    window.claude = { use: function(){ return Promise.reject(new Error("signed out")); } };
    return;
  }
  ls("la_silent_failed", null);

  // 3. Google APIs standing in for the Claude connectors
  function api(url, opt){
    opt = opt || {};
    opt.headers = Object.assign({Authorization:"Bearer " + token()}, opt.headers || {});
    return fetch(url, opt).then(function(r){
      if (r.status === 401) { ls("la_tok", null); signIn(true); throw {code:"needs_reauth", server:"Google"}; }
      return r.text().then(function(t){
        var j; try { j = t ? JSON.parse(t) : {}; } catch(e) { j = {raw:t}; }
        if (!r.ok) throw {code:"tool_error", server:"Google", message:(j.error && j.error.message) || ("HTTP " + r.status)};
        return j;
      });
    });
  }
  var SH = "https://sheets.googleapis.com/v4/spreadsheets/", DR = "https://www.googleapis.com/drive/v3/files";
  function enc(s){return encodeURIComponent(s)}
  function driveQ(q){return String(q||"").replace(/\btitle\b/g,"name").replace(/owner\s*=\s*'me'/g,"'me' in owners")}
  function b64ToBlob(b64,type){var bin=atob(b64),a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return new Blob([a],{type:type})}

  var tools = {
    "Google Sheets": {
      get_values: function(i){return api(SH+i.spreadsheetId+"/values/"+enc(i.range)+"?valueRenderOption=FORMATTED_VALUE")},
      update_values: function(i){return api(SH+i.spreadsheetId+"/values/"+enc(i.range)+"?valueInputOption=USER_ENTERED",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({values:i.values})})},
      get_spreadsheet: function(i){var f=Array.isArray(i.fields)?i.fields.join(","):(i.fields||"");return api(SH+i.spreadsheetId+(f?"?fields="+enc(f):""))},
      update_spreadsheet: function(i){return api(SH+i.spreadsheetId+":batchUpdate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requests:i.requests})})}
    },
    "Google Drive": {
      search_files: function(i){return api(DR+"?q="+enc(driveQ(i.query))+"&pageSize="+(i.pageSize||10)+"&fields="+enc("files(id,name,webViewLink)")+"&supportsAllDrives=true").then(function(j){return {files:(j.files||[]).map(function(f){return {id:f.id,title:f.name,viewUrl:f.webViewLink}})}})},
      create_file: function(i){
        var meta = {name:i.title, mimeType:i.contentMimeType}; if (i.parentId) meta.parents = [i.parentId];
        var c = i.base64Content;
        if (!c) return api(DR+"?fields=id,webViewLink",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(meta)}).then(function(j){return {id:j.id,viewUrl:j.webViewLink}});
        var blob = (c && c.$file) ? c.$file.data : b64ToBlob(c, i.contentMimeType || "application/octet-stream");
        var fd = new FormData();
        fd.append("metadata", new Blob([JSON.stringify(meta)],{type:"application/json"}));
        fd.append("file", blob);
        return api("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",{method:"POST",body:fd}).then(function(j){return {id:j.id,viewUrl:j.webViewLink}});
      }
    }
  };
  var mcp = {
    callTool: function(server, tool, input){
      var s = tools[server], f = s && s[tool];
      if (!f) return Promise.reject({code:"needs_claude", server:server, message:"That runs through Claude"});
      return f(input||{}).then(function(p){return {payload:p}});
    },
    listTools: function(){ return Promise.resolve({fileArgs:true}); },
    watchTool: function(){ return function(){}; }
  };
  window.claude = { use: function(cap){ return cap === "mcp" ? Promise.resolve(mcp) : Promise.reject(new Error("not here")); } };

  // 4. AI jobs (email sweep, statements, price checks) still run in Claude: open the right Claude page for them
  window.LA_openClaude = function(what){
    var em = (ls("la_email")||"").toLowerCase();
    var url = em === "djayres1@gmail.com" ? DARREN : SHARED;
    var m = document.getElementById("msg");
    if (m) m.textContent = what + " use Claude’s AI, so I’ve opened Life Admin in Claude to do it. Come back here afterwards; it’ll show the results.";
    window.open(url, "_blank");
  };

  // 5. Remember who signed in (for the silent refresh and the right Claude link)
  if (!ls("la_email")) api("https://www.googleapis.com/oauth2/v3/userinfo").then(function(u){ if (u.email) ls("la_email", u.email); }).catch(function(){});
})();
