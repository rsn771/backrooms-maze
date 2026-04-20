export default function handler(req, res) {
  const config = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  };

  const requiredKeys = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'];
  const enabled = requiredKeys.every(key => Boolean(config[key]));

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).json(
    enabled
      ? { enabled: true, ...config }
      : {
          enabled: false,
          reason: 'Set FIREBASE_* environment variables on Vercel to enable co-op.',
        }
  );
}
