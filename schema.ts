import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";


export const trades = sqliteTable("trades", {
	id: int().primaryKey({ autoIncrement: true }),
	user_id: text(),
	token: text(),
	side: text(),
	amount: text(),
	price: text(),
	tx_hash: text(),
	timestamp: text()
});

