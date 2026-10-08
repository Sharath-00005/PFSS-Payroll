-- PFSS Payroll: initial schema (PostgreSQL)

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,
  pass        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

CREATE TABLE sessions (
  token    TEXT PRIMARY KEY,
  user_id  TEXT NOT NULL,
  expires  BIGINT NOT NULL
);

-- Every payroll record is a JSON document: sites, employees, attendance,
-- runs, runlines (one payslip line per employee per month), approvals, config.
CREATE TABLE docs (
  collection  TEXT NOT NULL,
  id          TEXT NOT NULL,
  data        JSONB NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  PRIMARY KEY (collection, id)
);
CREATE INDEX docs_month ON docs (collection, (data->>'month'));

-- A counter per collection. Browsers poll it to learn when to refresh.
CREATE TABLE meta (
  collection  TEXT PRIMARY KEY,
  rev         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE audit (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     TEXT,
  action      TEXT NOT NULL,
  collection  TEXT,
  doc_id      TEXT
);

CREATE TABLE login_fails (
  fkey  TEXT PRIMARY KEY,
  n     INTEGER NOT NULL,
  t     BIGINT NOT NULL
);
