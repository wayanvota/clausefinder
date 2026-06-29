# Deployment

## Render

This repo includes `render.yaml` with two services.

1. Connect the GitHub repository to Render.
2. Create the services from `render.yaml`.
3. Set `VITE_API_BASE` on the static site to the backend URL, for example `https://clausefinder-api.onrender.com`.
4. Set `FRONTEND_ORIGIN` on the backend to the static site origin.
5. Set `OPENAI_API_KEY` on the backend as a Render secret.
6. Optionally set `OPENAI_MODEL`; the default is `gpt-4.1-mini`.
7. Deploy the backend first, then the frontend.

Do not commit `.env.local`. It is only for local development.

## Neon

Neon is optional for this version. The app works from `backend/data/far-index.json` and the OpenAI API key stored in Render.

Use Neon when you want to persist:

- search events,
- reviewer feedback,
- saved evaluation sets,
- source refresh logs.

Apply `backend/scripts/neon-schema.sql` to create the first two persistence tables.
