// RECLEF 공용 사진 인식 함수
// 사이트가 보낸 악보 사진(JPEG, base64)을 Google Gemini에 보내 음표 JSON을 받아 돌려줍니다.
// API 키는 Netlify 환경 변수 GEMINI_API_KEY 에만 넣으세요. 코드나 GitHub에는 절대 넣지 마세요.
//
// 환경 변수
//   GEMINI_API_KEY  (필수) Google AI Studio에서 받은 키
//   GEMINI_MODEL    (선택) 기본값 gemini-3.8-flash
//   GEMINI_FALLBACK_MODELS (선택) 쉼표로 구분. 기본값 gemini-3.6-flash,gemini-3.5-flash-lite
//   ALLOWED_ORIGIN  (선택) 예: https://reclef.netlify.app  → 다른 사이트에서 이 함수를 못 부르게 막음

const DEFAULT_MODEL = "gemini-3.8-flash";
const FALLBACK_MODELS = "gemini-3.6-flash,gemini-3.5-flash-lite";   // 기본 모델이 붐빌 때 차례로 써 볼 모델
const MAX_B64 = 5_000_000;         // Netlify 요청 한도(6MB)보다 작게
const TIMEOUT_MS = 55_000;         // Netlify 함수 실행 한도(60초)보다 짧게

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

// ▼ site/index.html 의 buildPrompt 와 똑같이 유지하세요
function buildPrompt(hint) {
  return `This image is a photo or scan of one page of sheet music. Transcribe ONE melodic line: ${hint ? "the part the user asked for: \"" + hint.replace(/["\\]/g, "") + "\"" : "the top line of the topmost staff (the melody)"}.
Reply with only JSON of this shape:
{"title":"","source":"c","keyFifths":-2,"meter":"4/4","tempo":100,"measures":[[["D4",4],["Eb4",4],["F4",8,"tie"]],[["F4",4],["r",12]]]}
Rules:
- source: the instrument this part is written for, read from a printed label such as "Trumpet in Bb", "Alto Sax" or "Trombone". One of: c (concert-pitch treble such as piano, voice, flute, violin), tpt, cl, asax, tsax, bsax, hn, gtr, bgt, tbn, vc, tba. With no label, use "tbn" for a bass-clef line and "c" otherwise.
- keyFifths: the key signature; sharps positive, flats negative, 0 for none.
- meter: the time signature such as "4/4", "3/4", "6/8". Use "4/4" for C and "2/2" for cut time.
- Each note is [pitch, length] or [pitch, length, "tie"] when it is tied to the next note.
- pitch: letter, optional accidental (#, b, ##, bb), octave number, with C4 = middle C. Write the pitch exactly as it reads on the staff with the key signature and any accidentals applied (a B in a key with one flat is "Bb4"). Read bass clef correctly if the staff uses it. Use "r" for a rest.
- length counts sixteenth notes: 16th=1, 8th=2, dotted 8th=3, quarter=4, dotted quarter=6, half=8, dotted half=12, whole=16. Round triplets so each measure still adds up.
- Each measure's lengths must add up to the time signature, except a pickup first measure. A whole-measure rest is ["r", full measure length].
- A multi-measure rest with a number N above it stands for N measures: write N separate whole-measure rests.
- Expand repeat signs, first/second endings and D.C./D.S. into the order they are played.
- If a chord appears in the line, keep only its top note. Ignore lyrics, chord symbols, fingering and dynamics.
- tempo: the quarter-note BPM if marked, otherwise 100. title: the printed title, or "".`;
}

export default async (req) => {
  const env = (k) => (globalThis.Netlify ? Netlify.env.get(k) : process.env[k]);
  const allowed = env("ALLOWED_ORIGIN");
  const origin = req.headers.get("origin");
  if (allowed && origin && !allowed.split(",").map((s) => s.trim()).includes(origin)) return json({ error: "forbidden" }, 403);

  const key = env("GEMINI_API_KEY");
  if (!key) return json({ error: "no_key" }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const image = typeof body?.image === "string" ? body.image : "";
  // 사이트는 항상 JPEG로 줄여서 보냅니다. JPEG의 base64는 "/9j/"로 시작해요.
  if (!image.startsWith("/9j/") || image.length > MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 4096)))
    return json({ error: "bad_request" }, 400);
  const hint = typeof body.hint === "string" ? body.hint.slice(0, 120) : "";

  // 모델이 붐비면(503) 잠깐 기다렸다 다시 시도하고, 그래도 안 되면 다음 모델로 넘어가요.
  const models = [env("GEMINI_MODEL") || DEFAULT_MODEL, ...(env("GEMINI_FALLBACK_MODELS") || FALLBACK_MODELS).split(",").map((s) => s.trim()).filter(Boolean)]
    .filter((m, i, a) => a.indexOf(m) === i);
  const payload = JSON.stringify({
    contents: [{ parts: [{ text: buildPrompt(hint) }, { inline_data: { mime_type: "image/jpeg", data: image } }] }],
    generationConfig: { responseMimeType: "application/json" },
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    let r = null, model = models[0], lastDetail = "";
    outer:
    for (const m of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        model = m;
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: payload, signal: ctl.signal,
        });
        if (r.ok) break outer;
        if (r.status === 429) { lastDetail = `Gemini 429 (${m})`; break; }            // 이 모델 한도 초과 → 다음 모델
        const raw = (await r.text()).slice(0, 600);
        console.log("gemini error", m, r.status, raw);
        let gs = ""; try { gs = JSON.parse(raw).error.status || ""; } catch {}
        lastDetail = `Gemini ${r.status} ${gs} (${m})`.trim();
        if (r.status === 400 || r.status === 401 || r.status === 403) return json({ error: "bad_server_key", detail: lastDetail, model: m }, 502);
        if (r.status === 404) break;                                                   // 없는 모델 → 다음 모델
        if (Date.now() - started > 35_000) break outer;                               // 시간이 얼마 안 남으면 그만
        if (attempt === 0) await new Promise((res) => setTimeout(res, 1500));         // 500/503 → 한 번 더
      }
    }
    if (!r || !r.ok) {
      if (r && r.status === 429) return json({ error: "quota", detail: lastDetail }, 429);
      if (r && r.status === 404) return json({ error: "bad_model", detail: lastDetail, model }, 502);
      return json({ error: r && (r.status === 503 || r.status === 500) ? "busy" : "server", detail: lastDetail, model }, 502);
    }
    const j = await r.json();
    const c = j?.candidates?.[0];
    if (!c) return json({ error: j?.promptFeedback?.blockReason ? "blocked" : "parse" }, 422);
    const text = (c.content?.parts || []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
    if (!text) return json({ error: c.finishReason && c.finishReason !== "STOP" ? "blocked" : "parse" }, 422);
    return json({ text, model });
  } catch (e) {
    if (e?.name === "AbortError") return json({ error: "timeout" }, 504);
    console.log("function error", e);
    return json({ error: "server" }, 502);
  } finally {
    clearTimeout(timer);
  }
};

export const config = { path: "/api/recognize", method: ["POST"] };
