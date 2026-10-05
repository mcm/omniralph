import { pool } from "../db.js";

export interface User {
  id: string;
  email: string;
  displayName: string;
}

const USER_COLUMNS = `id, email, display_name AS "displayName"`;

export async function findUserById(id: string): Promise<User | undefined> {
  const { rows } = await pool.query<User>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0];
}
