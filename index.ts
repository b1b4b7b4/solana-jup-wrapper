import { clusterApiUrl, Connection, Keypair, PublicKey, VersionedTransaction, type TokenBalance } from "@solana/web3.js";
import axios from "axios";
import bs58 from "bs58";
import { drizzle } from "drizzle-orm/libsql";
import fastify from "fastify";
import { trades } from "./schema";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";

const db = drizzle("file:local.db");
const server = fastify({ logger: true })

const CASHMINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const rpc = new Connection(clusterApiUrl("mainnet-beta"), "confirmed")
server.post("/buy", async (req, res) => {
	try {
		const { mint, amount, privateKeyBase58 } = req.body as Record<string, string>

		if (!mint || !amount || !privateKeyBase58) {
			res.send({ err: "mint, amount, privateKeyBase58 to make a transaction" })
		}

		const wallet = Keypair.fromSecretKey(bs58.decode(privateKeyBase58))

		const swapInfo = await doJupSwap({ outputMint: mint, inputMint: CASHMINT, amount }, wallet)
		const inserted = await db.insert(trades).values({
			amount,
			price: swapInfo.buyPrice,
			side: "BUY",
			timestamp: new Date().toString(),
			token: mint,
			tx_hash: swapInfo.tx,
			user_id: wallet.publicKey.toString(),
		}).returning()
		res.send(inserted)
	} catch (e: any) {
		res.send(e.message)
	}
})

server.post("/sell", async (req, res) => {
	try {
		const { mint, amount, privateKeyBase58 } = req.body as Record<string, string>
		if (!mint || !amount || !privateKeyBase58) {
			res.send({ err: "mint, amount, privateKeyBase58 to make a transaction" })
		}

		const wallet = Keypair.fromSecretKey(bs58.decode(privateKeyBase58))

		const swapInfo = await doJupSwap({ outputMint: CASHMINT, inputMint: mint, amount }, wallet)
		const inserted = await db.insert(trades).values({
			amount,
			price: swapInfo.buyPrice,
			side: "SELL",
			timestamp: new Date().toString(),
			token: mint,
			tx_hash: swapInfo.tx,
			user_id: wallet.publicKey.toString(),
		}).returning()
		res.send(inserted)
	} catch (e: any) {
		res.send(e.message)
	}
})

server.get("/pnl/:userId", async (req, res) => {
	// PnL = сумма(продаж * цена) - сумма(покупок * цена)
	// @ts-ignore
	const userId = req.params.userId
	const agg = await db
		.select({
			token: trades.token,
			balance: sql<number>`SUM(
        CASE WHEN ${trades.side} = 'BUY' THEN CAST(${trades.amount} AS REAL)
             ELSE -CAST(${trades.amount} AS REAL) END
      )`.as("balance"),
			costUsd: sql<number>`SUM(
        CASE WHEN ${trades.side} = 'BUY' THEN -CAST(${trades.amount} AS REAL) * CAST(${trades.price} AS REAL)
             ELSE  CAST(${trades.amount} AS REAL) * CAST(${trades.price} AS REAL) END
      )`.as("costUsd"),
		})
		.from(trades)
		.where(
			eq(trades.user_id, userId)
		)
		.groupBy(trades.token)
		.having(sql`SUM(
	     CASE WHEN ${trades.side} = 'BUY' THEN CAST(${trades.amount} AS REAL)
	          ELSE -CAST(${trades.amount} AS REAL) END
	   ) > 0`)


	if (agg.length === 0) {
		return res.send({
			user_id: userId,
			tokens: [],
			total_pnl: 0,
		});
	}

	const tokenList = agg.map((r) => r.token) as string[];
	const prices = await getJupPrices(tokenList);

	let totalPnL = 0;
	const tokensOut = agg.map((row) => {
		const curPrice = prices[row.token ?? ""] ?? 0;
		const currentValue = row.balance * curPrice;
		const pnl = currentValue - row.costUsd;
		totalPnL += pnl;
		return {
			token: row.token,
			pnl: Number(pnl.toFixed(6)),
		};
	});

	res.send({
		user_id: userId,
		tokens: tokensOut,
		total_pnl: Number(totalPnL.toFixed(6)),
	});
})

server.listen({ port: 4000 })
async function doJupSwap({ inputMint, outputMint, amount }: Record<string, string>, wallet: Keypair) {
	// const tokenDecimals = await getDecimals(inputMint);
	// const rawTokenAmount = new Decimal(amount).mul(10 ** tokenDecimals); // 50e9

	const tokenDecimals = await getDecimals(inputMint);
	const rawAmount = new Decimal(amount).mul(10 ** tokenDecimals);
	const order = await axios.get("https://lite-api.jup.ag/swap/v1/quote", {
		validateStatus: () => true,
		params: {
			inputMint,
			outputMint,
			amount: rawAmount.toString(),
		}
	})

	if (order.data.error) {
		throw new Error(order.data.error)
	}

	const swap = await axios.post("https://lite-api.jup.ag/swap/v1/swap", {
		userPublicKey: wallet.publicKey.toString(),
		quoteResponse: order.data
	})

	if (swap.data.error) {
		throw new Error(swap.data.error)
	}

	const { swapTransaction } = swap.data
	const trans = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"))
	trans.sign([wallet])
	const sig = trans.serialize()
	const txid = await rpc.sendRawTransaction(sig, {
		skipPreflight: false,
		preflightCommitment: "confirmed"
	})
	const confirmation = await rpc.confirmTransaction(txid, "confirmed")

	if (confirmation.value.err) {
		throw new Error('Tx failed on-chain');
	}

	const tx = await rpc.getParsedTransaction(txid, {
		commitment: 'confirmed',
		maxSupportedTransactionVersion: 0,
	});

	if (!tx || !tx.meta || !tx.meta.preTokenBalances || !tx.meta.postTokenBalances) {
		throw new Error('Transaction not found');
	}

	let preUsdAmt: TokenBalance,
		preTokenAmt: TokenBalance
	for (let t of tx.meta.preTokenBalances) {
		if (t.mint === CASHMINT) {
			preUsdAmt = t
		}
		if (t.mint === (inputMint === CASHMINT ? outputMint : inputMint)) {
			preTokenAmt = t
		}
	}

	let postUsdAmt: TokenBalance,
		postTokenAmt: TokenBalance
	for (let t of tx.meta.postTokenBalances) {
		//@ts-ignore
		if (t.mint === CASHMINT) {
			postUsdAmt = t
		}
		if (t.mint === (inputMint === CASHMINT ? outputMint : inputMint)) {
			postTokenAmt = t
		}
	}

	// @ts-ignore
	if (!preUsdAmt || !preTokenAmt || !postUsdAmt || !postTokenAmt) {
		throw new Error('Transaction not found');
	}

	const preUsd = new Decimal(preUsdAmt.uiTokenAmount.uiAmountString ?? "0")
	const preToken = new Decimal(preTokenAmt.uiTokenAmount.uiAmountString ?? "0");
	const postUsd = new Decimal(postUsdAmt.uiTokenAmount.uiAmountString ?? "0");
	const postToken = new Decimal(postTokenAmt.uiTokenAmount.uiAmountString ?? "0");

	const tokenDelta = postToken.minus(preToken).abs();
	const usdDelta = preUsd.minus(postUsd).abs();

	const buyPrice = usdDelta.dividedBy(tokenDelta).toString()


	console.log(tokenDelta.toString())
	console.log(usdDelta.toString())
	console.log(buyPrice)

	return {
		tx: txid,
		buyPrice,
	};
}

async function getJupPrices(tokens: string[]): Promise<Record<string, number>> {
	if (tokens.length === 0) return {};

	const res = await axios(`https://lite-api.jup.ag/price/v3`, {
		params: {
			ids: tokens.join(",")
		}
	});
	const out: Record<string, number> = {};
	for (const id of tokens) {
		out[id] = res.data[id]?.usdPrice ?? 0;
	}
	return out;
}

async function getDecimals(mint: string): Promise<number> {
	const info = await rpc.getParsedAccountInfo(new PublicKey(mint));
	return info.value?.data.parsed.info.decimals ?? 9;
}

