# Firebase Setup For Co-op

1. Create a Firebase project and add a Web app.
2. Enable `Authentication -> Sign-in method -> Anonymous`.
3. Create a `Realtime Database` in test mode first.
4. Copy the web app config values into Vercel environment variables:
   - `FIREBASE_API_KEY`
   - `FIREBASE_AUTH_DOMAIN`
   - `FIREBASE_DATABASE_URL`
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_STORAGE_BUCKET`
   - `FIREBASE_MESSAGING_SENDER_ID`
   - `FIREBASE_APP_ID`
5. Redeploy Vercel after adding env vars.

Recommended starter Realtime Database rules:

```json
{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

After that, open the deployed game, create a room, and share the `?room=CODE` link with other players.
