import sqlite3
import sys
import json
import os

DB_PATHS = [
    "/var/www/lucky-bingo/data/lucky_bingo.db",
    "/var/www/africa-bingo/data/africa_bingo.db",
    os.path.join(os.path.dirname(__file__), "data", "lucky_bingo.db"),
    os.path.join(os.path.dirname(__file__), "data", "africa_bingo.db"),
]

def get_connection():
    for p in DB_PATHS:
        if os.path.exists(p):
            conn = sqlite3.connect(p)
            conn.row_factory = sqlite3.Row
            return conn, p
    return None, None

def update_balance(user_id, balance):
    conn, path = get_connection()
    if not conn:
        print(json.dumps({"ok": False, "error": "db_not_found"}))
        return
    
    clean_id = str(user_id).strip()
    last9 = clean_id[-9:] if len(clean_id) >= 9 else clean_id
    num_bal = max(0.0, float(balance))

    c = conn.cursor()
    # Try updating by numeric ID or phone_number
    try:
        int_id = int(clean_id)
        c.execute("UPDATE users SET balance = ? WHERE id = ? OR phone_number LIKE ?", (num_bal, int_id, f"%{last9}"))
    except ValueError:
        c.execute("UPDATE users SET balance = ? WHERE id = ? OR phone_number LIKE ?", (num_bal, clean_id, f"%{last9}"))
    
    if c.rowcount == 0:
        try:
            int_id = int(clean_id) if clean_id.isdigit() else 9000000000 + (hash(clean_id) % 999999999)
            uname = clean_id
            fname = f"Player {last9[-4:]}"
            c.execute(
                "INSERT INTO users (id, username, first_name, last_name, phone_number, balance, bonus_balance, bonus_claimed, is_verified, status, registered_at, role) "
                "VALUES (?, ?, ?, '', ?, ?, 10.0, 1, 1, 'active', datetime('now'), 'player') "
                "ON CONFLICT(id) DO UPDATE SET balance = ?",
                (int_id, uname, fname, clean_id, num_bal, num_bal)
            )
        except Exception as e:
            pass
    
    conn.commit()
    conn.close()
    print(json.dumps({"ok": True, "balance": num_bal, "user_id": clean_id}))

def insert_transaction(tx_id, user_id, tx_type, method, amount, phone, status="pending"):
    conn, path = get_connection()
    if not conn:
        print(json.dumps({"ok": False, "error": "db_not_found"}))
        return
    
    clean_id = str(user_id).strip()
    int_id = int(clean_id) if clean_id.isdigit() else 0
    num_amount = float(amount)

    c = conn.cursor()
    try:
        c.execute(
            "INSERT INTO transactions (id, user_id, type, method, amount, phone_number, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) "
            "ON CONFLICT(id) DO UPDATE SET status = ?",
            (str(tx_id), int_id, str(tx_type), str(method), num_amount, str(phone), str(status), str(status))
        )
        conn.commit()
        print(json.dumps({"ok": True, "tx_id": tx_id}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
    finally:
        conn.close()

def update_transaction_status(tx_id, status):
    conn, path = get_connection()
    if not conn:
        print(json.dumps({"ok": False, "error": "db_not_found"}))
        return
    
    c = conn.cursor()
    try:
        c.execute("UPDATE transactions SET status = ? WHERE id = ?", (str(status), str(tx_id)))
        conn.commit()
        print(json.dumps({"ok": True, "tx_id": tx_id, "status": status, "rowcount": c.rowcount}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
    finally:
        conn.close()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing_action"}))
        sys.exit(1)
    
    action = sys.argv[1]
    if action == "update_balance" and len(sys.argv) >= 4:
        update_balance(sys.argv[2], sys.argv[3])
    elif action == "insert_transaction" and len(sys.argv) >= 8:
        insert_transaction(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7], sys.argv[8] if len(sys.argv) > 8 else "pending")
    elif action == "update_tx_status" and len(sys.argv) >= 4:
        update_transaction_status(sys.argv[2], sys.argv[3])
    else:
        print(json.dumps({"error": "invalid_action_or_args"}))
