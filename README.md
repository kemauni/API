# Freestyle Quest – Mobile Game API

    npm install && npm start     # http://localhost:3000

Auth: send `Authorization: Bearer <token>` (from /auth/register or /auth/login).

| Method | Route | What it does |
|---|---|---|
| POST | /auth/register, /auth/login, /auth/logout | accounts |
| GET | /me, /players/:id | profiles |
| POST | /scores | submit a run (xp, coins, high score) |
| GET | /leaderboard?limit=10 | top players |
| POST | /rewards/daily | 7-day streak reward |
| GET | /shop · POST /shop/buy | buy items with coins |
| GET | /inventory | owned items |
| POST | /match/join · GET /match/status · POST /match/leave · POST /match/:id/submit | 1v1 matchmaking |

Storage is in-memory – swap the Maps for Postgres/Redis for production.
