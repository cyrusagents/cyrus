// Disposable fixture adapter: execute the production store's query/RPC interface
// against real PostgreSQL. No authority or dispatch decision lives here.
import assert from "node:assert/strict";

const identifier = (s) => {
	assert.match(s, /^[a-z_][a-z0-9_]*$/);
	return `"${s}"`;
};
// Bun binds JSON objects itself; pre-stringifying would send a JSON string.
const value = (x) => x;
export function sqlAdapter(sql) {
	return {
		async rpc(name, args) {
			try {
				const entries = Object.entries(args).filter(([, v]) => v !== undefined);
				const [fn] =
					await sql`select proargnames, oidvectortypes(proargtypes) as types from pg_proc where proname=${name} and pronamespace='public'::regnamespace order by pronargs desc limit 1`;
				assert.ok(fn, `Fixture RPC missing: ${name}`);
				const types = fn.types.split(", ");
				const parameters = entries.map(([k, v]) => {
					const type = types[fn.proargnames.indexOf(k)];
					assert.ok(type, `Fixture RPC argument missing: ${k}`);
					return Array.isArray(v) && type.endsWith("[]")
						? `{${v.join(",")}}`
						: value(v);
				});
				const rows = await sql.unsafe(
					`select ${identifier(name)}(${entries.map(([k], i) => `${identifier(k)} => $${i + 1}`).join(",")}) as v`,
					parameters,
				);
				return { data: rows[0].v, error: null };
			} catch (error) {
				console.error(
					JSON.stringify({
						fixtureSqlError: [
							"query returned no rows",
							"Conversation event outside scope",
						].includes(error.message)
							? error.message
							: "Fixture SQL request failed",
						routine: name,
					}),
				);
				return { data: null, error: { message: error.message } };
			}
		},
		from(table) {
			identifier(table);
			const conditions = [],
				params = [],
				orders = [];
			let fields = "*",
				maximum,
				mutation,
				single = false,
				required = false;
			const parameter = (x) => {
				params.push(value(x));
				return `$${params.length}`;
			};
			const q = {
				select(f = "*") {
					fields = f;
					return q;
				},
				eq(k, v) {
					conditions.push(`${identifier(k)}=${parameter(v)}`);
					return q;
				},
				is(k, v) {
					assert.equal(v, null);
					conditions.push(`${identifier(k)} is null`);
					return q;
				},
				lt(k, v) {
					conditions.push(`${identifier(k)}<${parameter(v)}`);
					return q;
				},
				lte(k, v) {
					conditions.push(`${identifier(k)}<=${parameter(v)}`);
					return q;
				},
				in(k, vs) {
					conditions.push(
						vs.length
							? `${identifier(k)} in (${vs.map(parameter).join(",")})`
							: "false",
					);
					return q;
				},
				order(k, o = {}) {
					orders.push(
						`${identifier(k)} ${o.ascending === false ? "desc" : "asc"}`,
					);
					return q;
				},
				limit(n) {
					assert.ok(Number.isSafeInteger(n) && n > 0 && n <= 1000);
					maximum = n;
					return q;
				},
				update(v) {
					mutation = { kind: "update", values: v };
					return q;
				},
				upsert(v, o) {
					assert.equal(o.ignoreDuplicates, true);
					mutation = { kind: "insert", values: v, conflict: o.onConflict };
					return q;
				},
				single() {
					single = true;
					required = true;
					return q;
				},
				maybeSingle() {
					single = true;
					return q;
				},
				// biome-ignore lint/suspicious/noThenProperty: matches the awaited production query interface.
				async then(resolve) {
					try {
						const projection =
							fields === "*"
								? "*"
								: fields.split(",").map(identifier).join(",");
						const where = conditions.length
							? ` where ${conditions.join(" and ")}`
							: "";
						let statement;
						if (mutation) {
							const entries = Object.entries(mutation.values);
							statement =
								mutation.kind === "update"
									? `update ${identifier(table)} set ${entries.map(([k, v]) => `${identifier(k)}=${parameter(v)}`).join(",")}${where} returning ${projection}`
									: `insert into ${identifier(table)} (${entries.map(([k]) => identifier(k)).join(",")}) values (${entries.map(([, v]) => parameter(v)).join(",")}) on conflict (${mutation.conflict.split(",").map(identifier).join(",")}) do nothing returning ${projection}`;
						} else
							statement = `select ${projection} from ${identifier(table)}${where}${orders.length ? ` order by ${orders.join(",")}` : ""}${maximum ? ` limit ${maximum}` : ""}`;
						// PostgREST returns JSON numbers for bigint revisions; raw Bun rows
						// use strings. Preserve the production wire representation.
						const encoded = await sql.unsafe(
							mutation
								? `with changed as (${statement}) select to_jsonb(changed) as fixture_row from changed`
								: `select to_jsonb(selected) as fixture_row from (${statement}) selected`,
							params,
						);
						const rows = encoded.map((row) => row.fixture_row);
						if (single) {
							assert.ok(rows.length <= 1);
							if (required) assert.equal(rows.length, 1);
						}
						return resolve({
							data: single ? (rows[0] ?? null) : Array.from(rows),
							error: null,
						});
					} catch (error) {
						return resolve({ data: null, error: { message: error.message } });
					}
				},
			};
			return q;
		},
	};
}
