import { authenticateWriteKey } from "@retainos/database";
import { db } from "@/lib/db";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The embeddable feedback widget, served as a single script.
 *
 * Deliberately tiny and dependency-free, and deliberately limited: it collects
 * the category, a title, a description, an optional consented contact address,
 * and the page identifier the host page declares. It does not read the DOM,
 * does not take screenshots automatically, and cannot see form fields.
 */
export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key") ?? "";
  const scope = key ? authenticateWriteKey(db(), key) : null;
  const valid = Boolean(scope?.ok);
  const endpoint = process.env.RETAINOS_PUBLIC_URL ?? request.nextUrl.origin;

  const script = valid
    ? widgetScript(key, endpoint)
    : `console.warn("[retainos] feedback widget: unknown or missing project key; the widget was not mounted.");`;

  return new Response(script, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": valid ? "public, max-age=300" : "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function widgetScript(key: string, endpoint: string): string {
  return `(function () {
  "use strict";
  if (window.__retainosWidget) return;
  window.__retainosWidget = true;

  var KEY = ${JSON.stringify(key)};
  var ENDPOINT = ${JSON.stringify(endpoint)};
  var CATEGORIES = [
    ["bug", "Report a bug"],
    ["feature_request", "Request a feature"],
    ["improvement", "Suggest an improvement"],
    ["confusion", "Report confusing behaviour"],
    ["general", "Share general feedback"]
  ];

  var css = document.createElement("style");
  css.textContent = [
    ".ros-fab{position:fixed;right:20px;bottom:20px;z-index:2147483000;border:0;border-radius:999px;",
    "padding:11px 16px;font:500 13px/1 ui-sans-serif,system-ui,sans-serif;background:#2563eb;color:#fff;",
    "cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.28)}",
    ".ros-panel{position:fixed;right:20px;bottom:74px;z-index:2147483000;width:328px;max-width:calc(100vw - 40px);",
    "background:#0b1220;color:#f8fafc;border:1px solid #1d2b45;border-radius:14px;padding:16px;",
    "font:14px/1.5 ui-sans-serif,system-ui,sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.45)}",
    ".ros-panel h2{margin:0 0 10px;font-size:14px;font-weight:600}",
    ".ros-panel label{display:block;margin:10px 0 4px;font-size:11px;color:#94a3b8}",
    ".ros-panel select,.ros-panel input,.ros-panel textarea{width:100%;box-sizing:border-box;background:#060b16;",
    "border:1px solid #2a3b59;border-radius:8px;color:#f8fafc;padding:8px;font:13px/1.4 inherit}",
    ".ros-panel textarea{resize:vertical;min-height:76px}",
    ".ros-row{display:flex;gap:8px;align-items:flex-start;margin-top:10px}",
    ".ros-row input[type=checkbox]{width:auto;margin-top:3px}",
    ".ros-row span{font-size:11px;color:#94a3b8;line-height:1.45}",
    ".ros-actions{display:flex;gap:8px;margin-top:14px}",
    ".ros-actions button{flex:1;border:0;border-radius:8px;padding:9px;font:500 13px inherit;cursor:pointer}",
    ".ros-send{background:#2563eb;color:#fff}.ros-cancel{background:#141f33;color:#94a3b8}",
    ".ros-note{margin-top:10px;font-size:10px;line-height:1.5;color:#64748b}",
    ".ros-msg{margin-top:10px;font-size:12px}"
  ].join("");
  document.head.appendChild(css);

  var fab = document.createElement("button");
  fab.className = "ros-fab";
  fab.type = "button";
  fab.textContent = "Feedback";
  fab.setAttribute("aria-haspopup", "dialog");
  fab.setAttribute("aria-expanded", "false");
  document.body.appendChild(fab);

  var panel = null;

  function close() {
    if (panel) { panel.remove(); panel = null; }
    fab.setAttribute("aria-expanded", "false");
    fab.focus();
  }

  function open() {
    if (panel) return close();
    fab.setAttribute("aria-expanded", "true");
    panel = document.createElement("div");
    panel.className = "ros-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-label", "Send feedback");
    panel.innerHTML =
      '<h2>Send feedback</h2>' +
      '<label for="ros-kind">What kind of feedback?</label>' +
      '<select id="ros-kind">' + CATEGORIES.map(function (c) {
        return '<option value="' + c[0] + '">' + c[1] + '</option>';
      }).join("") + '</select>' +
      '<label for="ros-title">Summary</label>' +
      '<input id="ros-title" maxlength="200" placeholder="One line">' +
      '<label for="ros-body">Details</label>' +
      '<textarea id="ros-body" maxlength="8000" placeholder="What happened, and what did you expect?"></textarea>' +
      '<label for="ros-email">Your email (optional)</label>' +
      '<input id="ros-email" type="email" autocomplete="email" placeholder="you@example.com">' +
      '<div class="ros-row"><input type="checkbox" id="ros-consent">' +
      '<span><label for="ros-consent" style="display:inline;margin:0;color:inherit">You may contact me about this.</label>' +
      ' Your address is discarded unless this is ticked.</span></div>' +
      '<div class="ros-actions"><button type="button" class="ros-cancel">Cancel</button>' +
      '<button type="button" class="ros-send">Send</button></div>' +
      '<p class="ros-note">Only what you type here is sent, along with the page path. ' +
      'This widget does not read the page, your inputs or your keystrokes.</p>' +
      '<p class="ros-msg" role="status"></p>';
    document.body.appendChild(panel);
    panel.querySelector("#ros-title").focus();
    panel.querySelector(".ros-cancel").addEventListener("click", close);
    panel.querySelector(".ros-send").addEventListener("click", send);
    panel.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  }

  function send() {
    var msg = panel.querySelector(".ros-msg");
    var button = panel.querySelector(".ros-send");
    var title = panel.querySelector("#ros-title").value.trim();
    var body = panel.querySelector("#ros-body").value.trim();
    var consent = panel.querySelector("#ros-consent").checked;

    if (title.length < 3) {
      msg.style.color = "#f43f5e";
      msg.textContent = "Add a short summary first.";
      return;
    }

    button.disabled = true;
    msg.style.color = "#94a3b8";
    msg.textContent = "Sending…";

    fetch(ENDPOINT.replace(/\\/+$/, "") + "/api/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-retainos-key": KEY },
      body: JSON.stringify({
        kind: panel.querySelector("#ros-kind").value,
        title: title,
        body: body,
        source: "widget",
        contactEmail: consent ? panel.querySelector("#ros-email").value.trim() : null,
        consentToContact: consent,
        // The path only. Never the query string, which routinely carries tokens.
        pageIdentifier: location.pathname,
        productVersion: window.__retainosProductVersion || null,
        userId: window.__retainosUserId || null,
        anonymousId: (function () {
          try { return localStorage.getItem("retainos.anonymous_id"); } catch (e) { return null; }
        })()
      })
    }).then(function (r) {
      if (r.ok) {
        msg.style.color = "#34d399";
        msg.textContent = "Thank you. Your feedback was received.";
        setTimeout(close, 1800);
      } else {
        return r.json().catch(function () { return {}; }).then(function (j) {
          msg.style.color = "#f43f5e";
          msg.textContent = (j && j.error && j.error.message) || "That could not be sent. Please try again.";
          button.disabled = false;
        });
      }
    }).catch(function () {
      msg.style.color = "#f43f5e";
      msg.textContent = "Could not reach the server. Please try again.";
      button.disabled = false;
    });
  }

  fab.addEventListener("click", open);
})();`;
}
