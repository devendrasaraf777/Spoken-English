# English Bolo Tutor

A spoken-English tutor on the web. The learner talks; the tutor listens, replies by voice, corrects one mistake at a time with a tip in Hindi, Marathi or Bengali, and asks the learner to say the better sentence back.

Learners need no API key. The key lives only on the server, in a Vercel environment variable.

## How it fits together

| Part | File | Runs where |
| --- | --- | --- |
| Speaking page | `index.html` | Learner's browser (Chrome or Edge for listening) |
| Tutor function, situations and prompt | `api/tutor.js` | Vercel server; calls Claude with the owner's key |
| Tests | `test.js` | `npm test` |

The page sends only the situation, language, level, the learner's words and the recent conversation. The server builds the tutor prompt itself, so the public address cannot be used as a general Claude service.

## Deploy on Vercel

1. Push this folder to a GitHub repository.
2. At vercel.com, sign in with GitHub, choose **Add New → Project**, and import the repository. No build settings are needed.
3. Under **Settings → Environment Variables**, add:

| Name | Value | Required |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Your key from console.anthropic.com | Yes |
| `ACCESS_CODE` | A class code learners must type. Capitals and spaces are ignored. Several codes may be given, separated by commas (for example `batch1, batch2`). A variable named `Access_code` is also read. | Recommended |
| `TUTOR_MODEL` | `claude-haiku-5-5` (default) or `claude-sonnet-5-5` | No |
| `RATE_LIMIT` | Answers per device per 10 minutes (default 40) | No |

4. Redeploy. The site is live at `https://<project>.vercel.app`.

## Protect your spend

Anyone with the link can use the tutor, and each answer is charged to your key. Set `ACCESS_CODE` so only your learners can use it, and set a monthly spend limit in the Claude Console. On Claude Haiku 5.5 a reply costs about ₹0.014 (from the product plan's cost model).

## Speed

The tutor's answer is streamed. The page says the corrected sentence the moment Claude has written it, and, when there is no mistake, says the reply the moment it is written, while the rest (the tip in the learner's language) is still arriving. Tips are shown on screen and spoken only if the learner ticks "Speak tips aloud". Opening the page wakes the server, so the first answer does not wait for a cold start.

## Notes

Listening uses the browser's speech recognition (Indian English), which Chrome and Edge provide; Chrome sends the audio to Google's speech service. The tutor's voice is the device's own. Hindi tips are spoken where the device has a Hindi voice; Marathi and Bengali tips are shown on screen when the device has no voice for them.
