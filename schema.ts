import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";


export const trades = sqliteTable("trades", {
	id: int().primaryKey({ autoIncrement: true }),
	user_id: text().notNull(),
	token: text().notNull(),
	side: text().notNull(),
	amount: text().notNull(),
	price: text().notNull(),
	tx_hash: text().notNull(),
	timestamp: text().notNull()
});

