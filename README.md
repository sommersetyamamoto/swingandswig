# Swing & Swig

A live leaderboard for a Stableford scramble. Players enter scores from their phones, the board updates for everyone within a few seconds, and the tournament chair can hand out (or take away) points for any reason at all.

- **Leaderboard**: live standings, tap a team to see its card, and the chair's rulings feed
- **Scorecard**: one-tap stroke entry per hole, with points worked out for you
- **Chat**: clubhouse trash talk with emoji reactions, photos and videos
- **Chair** (password-protected): rulings, including hidden ones you reveal later, the "Roll a wildcard" button, scorecard lock, and event setup (name, course, date, 9 or 18 holes, pars, teams)

Stableford points: double bogey or worse 0 · bogey 1 · par 2 · birdie 3 · eagle 4 · albatross 5.

## How it's built

- `public/index.html`: the whole front end (no build step)
- `netlify/functions/api.mjs` + `src/handler.mjs`: a small API on Netlify Functions
- Data lives in **Netlify Blobs**, which comes with every Netlify site. There's no database to sign up for.
- Phones check for updates every 5 seconds while the page is open, and stop while it's in the background.

## Deploy

1. Push this folder to a new GitHub repo.
2. In Netlify: **Add new site → Import an existing project → GitHub**, then pick the repo. The build settings come from `netlify.toml`, so leave them as they are.
3. In **Site configuration → Environment variables**, add `CHAIR_PIN` set to the chair password (letters, numbers or both). Then trigger a redeploy so it takes effect.
4. Open the site, tap **Tournament chair? Sign in** at the bottom (or go to `/#chair`), enter the chair password, and set up the event and teams.
5. Share the link with players. They choose their team on the Scorecard tab.

## Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:8888 and use chair password `1234`. Local data is kept in memory and resets when the server stops. `netlify dev` also works if you have the Netlify CLI.

## Photos and videos in chat

- Photos are shrunk on the phone (to 1600px JPEG) before uploading, so they're quick even on a weak signal.
- Videos can be up to **50 MB** (roughly 30 seconds of iPhone 1080p video). They upload in 3 MB pieces because Netlify Functions accept about 6 MB per request, and they play back with seeking.
- Files live in the same Netlify Blobs store as everything else. Deleting a message deletes its photo or video too. The chat keeps the newest 300 messages and removes older files with them.
- Every view of a video streams through the site's function, so lots of video counts against your Netlify bandwidth and function usage.

## Notes

- Anyone with the link can enter scores for any team, like a paper card in the cart. Lock the scorecards when the round ends.
- Hidden rulings never leave the server for non-chair viewers.
- To reset for a new event, delete the `swing-and-swig` store under **Blobs** in the Netlify UI, or use new team names.
