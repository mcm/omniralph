-- Users can have several addresses; users.email stays the primary one for now.
CREATE TABLE user_emails (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  verified_at timestamptz,
  PRIMARY KEY (user_id, email)
);

INSERT INTO user_emails (user_id, email)
SELECT id, email FROM users;
