"use strict";
const crypto = require("node:crypto");
const http2 = require("node:http2");
const { GoogleAuth } = require("google-auth-library");
const { providerResult } = require("./domain");

function createProviders({ env = process.env, request = fetch, connect = http2.connect, now = Date.now, Auth = GoogleAuth } = {}) {
  let auth, appleJWT, appleIssued = 0;
  function appleToken() {
    const issued = Math.floor(now() / 1000);
    if (appleJWT && issued - appleIssued < 3000 && issued >= appleIssued) return appleJWT;
    if (!/^[A-Z0-9]{10}$/.test(env.APNS_KEY_ID || "") || !/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID || "") || env.APNS_TOPIC !== "com.gymdrobe.app") throw new Error("PUSH_CREDENTIALS");
    const key = crypto.createPrivateKey(String(env.APNS_PRIVATE_KEY || "").replace(/\\n/g, "\n"));
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("PUSH_CREDENTIALS");
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const value = `${encode({ alg: "ES256", kid: env.APNS_KEY_ID })}.${encode({ iss: env.APPLE_TEAM_ID, iat: issued })}`;
    appleJWT = `${value}.${crypto.sign("sha256", Buffer.from(value), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    appleIssued = issued;
    return appleJWT;
  }
  async function apns(device, token, message) {
    if (!["sandbox", "production"].includes(env.APNS_ENVIRONMENT) || device.environment !== env.APNS_ENVIRONMENT) return { state: "failed", code: "PROVIDER_ENVIRONMENT" };
    let authorization;
    try { authorization = appleToken(); }
    catch { return { state: "failed", code: "PROVIDER_CREDENTIALS" }; }
    // Persisted 'sending' has already been written. An interrupted connection
    // can have reached APNs; never turn that ambiguity into a duplicate retry.
    return new Promise(resolve => {
      let client, stream, timer, finished = false, status = 0, body = "";
      const done = result => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        stream?.close(); client?.destroy(); resolve(result);
      };
      try {
        client = connect(device.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com");
        timer = setTimeout(() => done({ state: "uncertain", code: "PROVIDER_TIMEOUT" }), 10000);
        client.on("error", () => done({ state: "uncertain", code: "PROVIDER_CONNECTION" }));
        stream = client.request({ ":method": "POST", ":path": `/3/device/${token}`, authorization: `bearer ${authorization}`,
          "apns-topic": env.APNS_TOPIC, "apns-push-type": "alert", "apns-priority": "10",
          "apns-expiration": String(Math.floor(now() / 1000) + 3600), "apns-collapse-id": message.collapseId });
        stream.on("response", headers => { status = Number(headers[":status"]); });
        stream.on("data", chunk => { body += chunk; if (body.length > 16384) done({ state: "uncertain", code: "PROVIDER_RESPONSE" }); });
        stream.on("error", () => done({ state: "uncertain", code: "PROVIDER_CONNECTION" }));
        stream.on("end", () => {
          let reason = ""; try { reason = JSON.parse(body || "{}").reason; } catch { /* Keep a sanitized status. */ }
          done(providerResult(status, reason));
        });
        stream.end(JSON.stringify({ aps: { alert: { title: message.title, body: message.body }, sound: "default" }, ...message.data }));
      } catch { done({ state: "uncertain", code: "PROVIDER_CONNECTION" }); }
    });
  }
  async function fcm(_device, token, message) {
    let access;
    try {
      if (!/^[a-z][a-z0-9-]{4,62}$/.test(env.FCM_PROJECT_ID || "")) throw new Error("PUSH_CREDENTIALS");
      if (!auth) {
        const credentials = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON || "{}");
        if (credentials.type !== "service_account" || credentials.project_id !== env.FCM_PROJECT_ID || !credentials.client_email || !credentials.private_key) throw new Error("PUSH_CREDENTIALS");
        auth = new Auth({ credentials, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
      }
      let timer;
      try { access = await Promise.race([auth.getAccessToken(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("PUSH_CREDENTIALS")), 8000); })]); }
      finally { clearTimeout(timer); }
      if (typeof access !== "string" || !access) throw new Error("PUSH_CREDENTIALS");
    } catch { return { state: "failed", code: "PROVIDER_CREDENTIALS" }; }
    try {
      const response = await request(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
        method: "POST", signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { token, notification: { title: message.title, body: message.body }, data: message.data,
          android: { priority: "normal", ttl: "3600s", collapse_key: message.collapseId,
            notification: { channel_id: "gymdrobe-orders", icon: "ic_order_notification", tag: message.collapseId } } } }),
      });
      let body = {}; try { body = await response.json(); } catch { /* A status still gives a definite rejection/acceptance. */ }
      const code = body.error?.details?.find?.(detail => detail["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError")?.errorCode;
      return providerResult(response.status, code);
    } catch { return { state: "uncertain", code: "PROVIDER_CONNECTION" }; }
  }
  return { send: (device, token, message) => device.platform === "ios" ? apns(device, token, message) : fcm(device, token, message) };
}
module.exports = { createProviders };
