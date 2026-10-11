# English Bolo Tutor

A spoken-English tutor on the web that works like a phone call. The learner taps Start once and then simply talks: the tutor listens all the time, notices when the learner has finished (a short pause), replies by voice, corrects one mistake at a time with a tip in Hindi, Marathi or Bengali, and asks the learner to say the better sentence back. The learner can interrupt the tutor by talking, and can keep talking while the tutor is thinking. Typing is there only as a fallback.

Learners need no API key. The key lives only on the server, in a Vercel environment variable.

## How it fits together

| Part | File | Runs where |
| --- | --- | --- |
| Speaking page | `index.html` | Learner's browser (Chrome or Edge for listening) |
| Tutor function, situations and prompt | `api/tutor.js` | Vercel server; calls Claude with the owner's key |
| Learner accounts and payments (shared code) | `lib/accounts.js` | Vercel server |
| Plans and payment | `api/billing.js` | Vercel server; calls Razorpay and Supabase |
| Payment notices from Razorpay | `api/razorpay-webhook.js` | Vercel server |
| Database: profiles, trial, plans, usage | `supabase/schema.sql` | Supabase (run once) |
| Tests | `test.js`, `test-accounts.js` | `npm test` |

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

Anyone with the link can use the tutor, and each answer is charged to your key. Set `ACCESS_CODE` so only your learners can use it, and set a monthly spend limit in the Claude Console. On Claude Haiku 5.5 a typical reply costs about ₹0.03, and at most about ₹0.047 (Anthropic list prices of $0.10 input and $0.50 output per million tokens, at ₹95 to the dollar). A 15-minute conversation of about 40 replies costs roughly ₹1.22.

## Learner accounts and subscriptions

When the Supabase settings below are added in Vercel, the site asks every learner to sign in, and the class code is no longer used. Until then the site keeps working with the class code.

| What the learner gets | Detail |
| --- | --- |
| Account | Email and password, with email confirmation and password reset |
| Profile | Name, mobile number (optional), tips language, level, what they practise for, and a statement that they are 18 or older or have a parent's or guardian's agreement. The profile sets the practice defaults. |
| Free trial | 7 days or 140 tutor replies, whichever ends first. No payment details needed. |
| Basic | ₹149 a month including GST, 400 tutor replies a month |
| Plus | ₹299 a month including GST, 400 replies a month. Shown as "coming soon" until `PLUS_ENABLED` is set, because its extra features are not built yet. |
| Payment | Razorpay Checkout; the plan renews every month until cancelled |
| Cancel | Stops the next payment; the plan runs to the end of the month already paid for |
| Delete account | From the profile: stops any plan at once and deletes the account and all its data |

The allowance is checked on the server for every tutor reply (`use_reply` in `supabase/schema.sql`), so it cannot be bypassed from the browser. Plan numbers live in the `plan_limits` table and can be changed there. A request that is cancelled because the learner carried on talking still counts as one reply.

### Set-up, step by step (test mode first)

1. **Supabase.** Create a project at supabase.com and choose the region South Asia (Mumbai). Open SQL Editor, paste the whole of `supabase/schema.sql` and press Run.
2. **Supabase sign-in settings.** Under Authentication, URL Configuration, set Site URL to `https://english-bolo-tutor.vercel.app` and add the same address under Redirect URLs.
3. **Supabase email.** Supabase's built-in email sends only to your own team's addresses, at about 2 messages an hour. That is enough for you to test. Before real learners sign up, connect an email service under Authentication, SMTP Settings, or switch off "Confirm email" for the time being. Password reset always needs email.
4. **Supabase keys.** Under Project Settings, API Keys, copy the Publishable key and the Secret key.
5. **Razorpay (you must open the account and complete KYC yourself).** In Test Mode, go to Subscriptions, then Plans, and create two monthly plans: Basic at ₹149 and Plus at ₹299. Copy each Plan ID (it starts with `plan_`). Under Account & Settings, API Keys, generate a test key and copy the Key ID and Key Secret.
6. **Razorpay webhook.** Under Webhooks, add `https://english-bolo-tutor.vercel.app/api/razorpay-webhook`, choose a secret, and tick the subscription events (authenticated, activated, charged, pending, halted, cancelled, completed, paused, resumed, updated).
7. **Vercel.** Add the variables below, then redeploy.
8. **Try it.** Create an account, use the trial, choose Basic and pay with Razorpay's test payment details, cancel, and delete the account.

| Vercel variable | Value |
| --- | --- |
| `SUPABASE_URL` | Project URL, e.g. `https://abcd.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key (safe to show in the browser). A legacy `SUPABASE_ANON_KEY` also works. |
| `SUPABASE_SECRET_KEY` | Secret key (server only). A legacy `SUPABASE_SERVICE_ROLE_KEY` also works. |
| `RAZORPAY_KEY_ID` | Key ID |
| `RAZORPAY_KEY_SECRET` | Key Secret (server only) |
| `RAZORPAY_WEBHOOK_SECRET` | The webhook secret you chose |
| `RAZORPAY_PLAN_BASIC` | Plan ID of Basic |
| `RAZORPAY_PLAN_PLUS` | Plan ID of Plus |
| `PLUS_ENABLED` | Leave empty until Plus has its extra features; `1` to sell it |

### Before taking real payments

- Switch Razorpay to Live Mode, create the two plans again there, generate live keys and a live webhook, and replace the test values in Vercel.
- Decide the billing name and GSTIN, and enter them in Razorpay.
- Razorpay's website check asks for these pages: Contact us, Pricing, Terms and conditions, Privacy policy, Cancellation and refunds (and Shipping and About us in its set-up guide). They are not part of this site yet.
- Free Supabase projects pause after 1 week with no activity; the Pro plan avoids this.

## Live conversation

| Feature | How it works |
| --- | --- |
| No buttons after Start | The microphone stays on for the whole conversation. On Chrome for Android, which stops listening after each phrase, it is restarted automatically and the pieces are joined into one answer. |
| End of the learner's turn | A pause the learner chooses: short (1 second), normal (1.5 seconds) or long (2.5 seconds). |
| Interrupting the tutor | If the learner says three or more words that are not the tutor's own, the tutor stops and listens. Tapping the button also interrupts. |
| Tutor's own voice | Words the tutor said, picked up from the loudspeaker, are not taken as the learner's answer. Earphones avoid the problem altogether. |
| Carrying on | If the learner keeps talking while the tutor is thinking, the request is cancelled and the whole answer is sent once they finish. |
| Silence | After 15 seconds the tutor says "Take your time"; after about 45 seconds the conversation pauses and the microphone switches off. |
| Typing | "Type instead" sends a typed answer at any point. Browsers that cannot listen use typing, with spoken replies. |

## Grammar rules

Corrections follow the english-grammar skill's rule register (version 1.1, 11.10.2026; base: Wren & Martin). The tutor is given 45 rules, each with its ID, and must name the rule it applies; the server drops any ID not on the list. Rules marked U or C in the register are not used, because the register does not treat them as errors. Indian usages such as "prepone" or "cousin brother" are corrected only in job-interview and workplace situations. Accepted usage, such as a sentence starting with "And" or "two years back", is never corrected.

## Speed

The tutor's answer is streamed. The page says the corrected sentence the moment Claude has written it, and, when there is no mistake, says the reply the moment it is written, while the rest (the tip in the learner's language) is still arriving. Tips are shown on screen and spoken only if the learner ticks "Speak tips aloud". Opening the page wakes the server, so the first answer does not wait for a cold start.

## Notes

Listening uses the browser's speech recognition (Indian English). Chrome on a computer or on Android is the browser to use; Chrome sends the audio to Google's speech service. Safari supports speech recognition from version 14.1 (iOS 14.5) with partial support. For Edge the two reference sources differ (MDN lists support, caniuse does not), so test it before relying on it. Firefox does not listen; it falls back to typing. The tutor's voice is the device's own. Hindi tips are spoken where the device has a Hindi voice; Marathi and Bengali tips are shown on screen when the device has no voice for them.
