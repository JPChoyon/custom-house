# Production Database

Development remains SQLite. Production SQLite requires durable single-instance storage and backups; ephemeral/container filesystems are unsafe. For PostgreSQL: provision an encrypted managed database, rehearse export/transformation in staging, change only the Prisma datasource provider/URL, generate a reviewed baseline migration, import while writes are paused, validate counts/constraints, rotate credentials, deploy one migrator, and retain a rollback snapshot. Never point `migrate dev` at production.
