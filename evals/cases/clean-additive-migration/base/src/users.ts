import { pool } from "./db.js";

export async function findUserByEmail(email: string) {
  const { rows } = await pool.query(
    "SELECT id, email, display_name FROM users WHERE email = $1",
    [email.toLowerCase()],
  );
  return rows[0];
}
