# Dibiaa Hub Discord Ticket Bot — patched build

## Fixes in this build
- Panel publish no longer reports a false failure just because Render cannot call the InfinityFree API.
- Panel questions are cached in the bot when the website publishes the panel.
- The Create Ticket button opens the modal from cached panel data.
- Submitting the form creates a private Discord ticket channel.
- Website database sync is best-effort and logs the exact reason if InfinityFree blocks the request.
- Adds a Close Ticket button and optional category/support role configuration.

## Render environment variables
Required:
- `DISCORD_TOKEN`
- `API_KEY` (must match `BOT_API_KEY` in website `includes/config.php`)
- `WEBSITE_API_URL` (for example `https://dibiaa.free.nf/api/bot.php`)
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI` = `https://dibiaa.free.nf/discord-callback.php`

Optional:
- `TICKET_CATEGORY_ID` = Discord category ID where new ticket channels should be created
- `SUPPORT_ROLE_ID` = support team role ID to grant access and mention

## Deploy
1. Replace the current Render bot project files with this ZIP's contents.
2. Keep your secret values in Render Environment, not in source code.
3. Deploy the service.
4. Re-open the Ticket Panel Builder and publish the panel again. Re-publishing is required because the bot caches the panel questions in memory.
5. Test Create Ticket. The bot should open the form and create a private ticket channel.

## Important database limitation
The logs you shared show InfinityFree returns an HTML page containing `/aes.js` to requests made from Render. InfinityFree's free-hosting security layer blocks automated/server-to-server API calls; the API key or PHP changes cannot disable this host-level protection. This build makes Discord ticket creation work without that API call being mandatory, but ticket records may not appear in the website's MySQL dashboard until the API/database is moved to a host that supports server-to-server API access or an external storage bridge is configured.

## Security
Your previous ZIP included credentials. Rotate the Discord client secret, database password, and API key, then update the Render environment variables and website config. Do not commit secrets to GitHub.
