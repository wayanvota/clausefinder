# Security And Sensitive Information

ClauseFinder is a public-source acquisition-rule search tool. It is not designed to receive sensitive acquisition material.

Do not paste or submit:

- CUI.
- Source-selection information.
- Technical or cost proposal text.
- Proprietary contractor information.
- Personal identifiers.
- Contract numbers tied to sensitive facts.
- Classified, export-controlled, or restricted program details.

The app includes basic sensitive-text checks, but those checks are not a security boundary. Users remain responsible for keeping sensitive material out of the tool.

## Secrets

Do not commit:

- `OPENAI_API_KEY`.
- `DATABASE_URL`.
- Render secrets.
- Neon connection strings.
- `.env` or `.env.*` files.
- User logs or query exports containing sensitive text.

## Reporting A Concern

Open a GitHub issue for public-source bugs, documentation errors, or retrieval-quality problems.

Do not put secrets or sensitive acquisition facts in a public issue. If a concern cannot be described without sensitive details, contact Wayan Vota directly through the contact path on [wayan.com](https://wayan.com/).
