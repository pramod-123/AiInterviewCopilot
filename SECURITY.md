# Security

## Reporting a vulnerability

Please report security issues privately to the repository maintainers (use GitHub **Security → Report a vulnerability** if enabled, or contact the repo owner directly). Do not open a public issue for undisclosed security bugs.

## Operational notes

- This service processes **user-uploaded video** and calls **third-party APIs** (e.g. OpenAI). Run it only in environments you trust, with appropriate rate limits and monitoring.
- **API keys** belong in environment variables or a secrets manager, not in the repository.
