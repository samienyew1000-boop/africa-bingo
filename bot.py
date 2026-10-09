import os
import sys
import json
import sqlite3
import logging
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler
from datetime import datetime
from typing import Dict, Any, Optional, List
import hashlib
import hmac
import time
import urllib.parse
import random

def validate_telegram_webapp(init_data: str) -> Optional[Dict[str, Any]]:
    """Validate Telegram WebApp initData and return the user dict if valid."""
    if not init_data:
        return None
    try:
        parsed = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
        received_hash = parsed.pop('hash', '')
        # Build the check string
        data_check = '\n'.join(f'{k}={v}' for k, v in sorted(parsed.items()))
        secret_key = hmac.new(b'WebAppData', BOT_TOKEN.encode(), hashlib.sha256).digest()
        calculated_hash = hmac.new(secret_key, data_check.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calculated_hash, received_hash):
            return None
        user_data = json.loads(parsed.get('user', '{}'))
        return user_data if user_data.get('id') else None
    except Exception:
        return None

# Ensure stdout and stderr handle UTF-8 without crashing on Windows cp1252 consoles
if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
    WebAppInfo,
    BotCommand,
    MenuButtonCommands,
    MenuButtonWebApp,
)
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

# ==============================================================================
# CONFIGURATION
# ==============================================================================
def load_dotenv(filepath=".env"):
    if os.path.exists(filepath):
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN", "8882887936:AAEXtkABLYGWPSC-r4tXRMAOzET9Jp21NUQ")
raw_web_url = os.getenv("WEB_APP_URL", "https://africa-bingo.ethiodeploy.com/").strip()
WEB_APP_URL = raw_web_url if raw_web_url.endswith("/") else f"{raw_web_url}/"
GROUP_URL = os.getenv("GROUP_URL", "https://t.me/Africa1bingo_bot")
CONTACT_URL = os.getenv("CONTACT_URL", "https://t.me/su121316")

def get_game_web_url(subpath: str = "", extra_query: str = "", is_admin_user: bool = False, user_id: int = 0) -> str:
    """Builds authoritative WebApp URL including tunnel API and role params."""
    base = WEB_APP_URL.rstrip("/")
    if subpath:
        base = f"{base}/{subpath.lstrip('/')}"

    fragment = ""
    if extra_query and extra_query.startswith("#"):
        fragment = extra_query
        extra_query = ""

    tunnel_url = os.getenv("TUNNEL_API_URL") or os.getenv("PUBLIC_API_URL", "https://africa-bingo.ethiodeploy.com")
    params = []
    params.append(f"v={int(time.time())}")
    if tunnel_url and "api=" not in base:
        params.append(f"api={urllib.parse.quote(tunnel_url, safe='')}")
    if is_admin_user:
        params.append(f"role=admin&admin=1&u={user_id}")
    if extra_query:
        params.append(extra_query.lstrip("?&"))

    if params:
        sep = "&" if "?" in base else "?"
        base = f"{base}{sep}{'&'.join(params)}"
    if fragment:
        base = f"{base}{fragment}"
    return base

# Authorized Administrators (comma-separated in .env or set here)
raw_usernames = os.getenv("ADMIN_USERNAMES", "0999909474,su121316,samTesfa19,samienyew1000,Africabingooo")
ADMIN_USERNAMES = [u.strip().lstrip("@").lower() for u in raw_usernames.split(",") if u.strip()]
raw_phones = os.getenv("ADMIN_PHONES", "0999909474,+251999909474,+251939292694")
ADMIN_PHONES = [p.strip() for p in raw_phones.split(",") if p.strip()]
raw_ids = os.getenv("ADMIN_TELEGRAM_IDS", "5663531258")
ADMIN_TELEGRAM_IDS = [int(i.strip()) for i in raw_ids.split(",") if i.strip().isdigit()]
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "AF7694")

DB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_PATH = os.path.join(DB_DIR, "africa_bingo.db")
PLAYERS_DATA_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "players-data.js")
PLAYERS_JSON = os.path.join(DB_DIR, "players.json")

# Secondary mirror path if present
MIRROR_DIR = r"C:\Users\HP\Desktop\telegram bot bingo"
MIRROR_PLAYERS_DATA_JS = os.path.join(MIRROR_DIR, "players-data.js")

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

def validate_telegram_webapp(init_data: str) -> Optional[Dict[str, Any]]:
    """Validate Telegram WebApp initData and return the user dict if valid."""
    if not init_data:
        return None
    try:
        parsed = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
        received_hash = parsed.pop("hash", "")
        if not received_hash:
            return None
        data_check = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode("utf-8"), hashlib.sha256).digest()
        calculated_hash = hmac.new(secret_key, data_check.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calculated_hash, received_hash):
            return None
        user_json = parsed.get("user")
        if user_json:
            user_data = json.loads(user_json)
            if isinstance(user_data, dict) and user_data.get("id"):
                return user_data
    except Exception as e:
        logger.warning("Error validating telegram webapp initData: %s", e)
    return None

# ==============================================================================
# DATABASE MANAGEMENT (SQLite)
# ==============================================================================
def normalize_phone(phone: str) -> str:
    """Normalize phone number to international Ethiopian format (+251...)."""
    if not phone:
        return ""
    cleaned = "".join(c for c in phone if c.isdigit() or c == "+")
    if cleaned.startswith("+251"):
        return cleaned
    if cleaned.startswith("251"):
        return "+" + cleaned
    if cleaned.startswith("09") and len(cleaned) == 10:
        return "+251" + cleaned[1:]
    if cleaned.startswith("07") and len(cleaned) == 10:
        return "+251" + cleaned[1:]
    if len(cleaned) == 9 and (cleaned.startswith("9") or cleaned.startswith("7")):
        return "+251" + cleaned
    if not cleaned.startswith("+"):
        return "+" + cleaned
    return cleaned

def is_admin_check(user_id: int, username: str = "", phone: str = "") -> bool:
    """Check if the given user is an authorized administrator."""
    if user_id in ADMIN_TELEGRAM_IDS:
        return True
    clean_user = (username or "").lstrip("@").strip().lower()
    if clean_user and clean_user in [u.lower() for u in ADMIN_USERNAMES]:
        return True
    if phone:
        norm = normalize_phone(phone)
        for ap in ADMIN_PHONES:
            if norm == normalize_phone(ap):
                return True
    # Also check if marked as admin in DB
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT role FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
            if row and row["role"] == "admin":
                return True
    except Exception:
        pass
    return False

def notify_admins_transaction(tx_id: str, tx_type: str, amount: float, method: str, user_info: dict, reference: str = "") -> None:
    """Send immediate notification to all authorized administrators via Telegram bot API."""
    import urllib.request
    token = os.getenv("BOT_TOKEN") or BOT_TOKEN
    if not token or token == "YOUR_BOT_TOKEN_HERE":
        return

    admin_targets = set(ADMIN_TELEGRAM_IDS)
    admin_targets.add(5663531258)
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            c.execute("SELECT id FROM users WHERE role = 'admin'")
            for r in c.fetchall():
                admin_targets.add(r["id"])
    except Exception:
        pass

    user_name = user_info.get("first_name", "") or ""
    if user_info.get("last_name"):
        user_name += " " + user_info.get("last_name")
    if not user_name.strip():
        user_name = f"@{user_info.get('username')}" if user_info.get("username") else f"User {user_info.get('id', 'N/A')}"

    phone = user_info.get("phone_number") or reference or "N/A"
    type_am = "አዲስ የተቀማጭ ጥያቄ (Deposit)" if tx_type == "deposit" else "አዲስ የገንዘብ ማውጣት ጥያቄ (Withdraw)"

    text = (
        f"🔔 *{type_am} ደርሷል!*\n\n"
        f"👤 *ተጫዋች:* {user_name}\n"
        f"💰 *መጠን:* `{amount:.2f} ETB`\n"
        f"💳 *መንገድ:* {method}\n"
        f"📱 *ስልክ / ማጣቀሻ (Ref):* `{phone}`\n"
        f"🆔 *የግብይት መለያ (ID):* `{tx_id}`\n\n"
        f"በ Admin Panel ወይም በ Bot ለማጽደቅ:\n"
        f"/admin"
    )

    for chat_id in admin_targets:
        try:
            payload = {
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "Markdown",
                "reply_markup": {
                    "inline_keyboard": [
                        [
                            {"text": "✓ አጽድቅ (Approve)", "callback_data": f"tx_app_{tx_id}"},
                            {"text": "× ሰርዝ (Reject)", "callback_data": f"tx_rej_{tx_id}"}
                        ]
                    ]
                }
            }
            req = urllib.request.Request(
                f"https://api.telegram.org/bot{token}/sendMessage",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"}
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            logger.warning("Failed to notify admin %s of %s: %s", chat_id, tx_id, e)

def init_db() -> None:
    os.makedirs(DB_DIR, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                last_name TEXT,
                phone_number TEXT UNIQUE,
                role TEXT DEFAULT 'player',
                balance REAL DEFAULT 0.0,
                bonus_balance REAL DEFAULT 0.0,
                bonus_claimed INTEGER DEFAULT 0,
                is_verified INTEGER DEFAULT 0,
                status TEXT DEFAULT 'active',
                registered_at TEXT,
                last_active TEXT
            )
        """)
        # Backward-compatible column check
        try:
            cursor.execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'player'")
        except sqlite3.OperationalError:
            pass

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id TEXT PRIMARY KEY,
                user_id INTEGER,
                type TEXT,
                method TEXT,
                amount REAL,
                phone_number TEXT,
                status TEXT DEFAULT 'completed',
                created_at TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        """)
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS game_rooms (
                id TEXT PRIMARY KEY,
                status TEXT DEFAULT 'open',
                round_id INTEGER DEFAULT 0,
                countdown_ends_at REAL DEFAULT 0,
                updated_at TEXT
            )
        """)
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS room_players (
                room_id TEXT,
                user_id INTEGER,
                round_id INTEGER,
                card_ids TEXT DEFAULT '[]',
                joined_at TEXT,
                PRIMARY KEY (room_id, user_id, round_id),
                FOREIGN KEY(room_id) REFERENCES game_rooms(id),
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        """)
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS game_calls (
                room_id TEXT,
                round_id INTEGER,
                call_index INTEGER,
                number INTEGER,
                called_at TEXT,
                PRIMARY KEY (room_id, round_id, call_index)
            )
        """)
        
        cursor.execute("INSERT OR IGNORE INTO game_rooms (id, status, round_id, updated_at) VALUES ('10', 'open', 0, datetime('now'))")
        cursor.execute("INSERT OR IGNORE INTO game_rooms (id, status, round_id, updated_at) VALUES ('20', 'open', 0, datetime('now'))")
        cursor.execute("INSERT OR IGNORE INTO game_rooms (id, status, round_id, updated_at) VALUES ('50', 'open', 0, datetime('now'))")
        try:
            cursor.execute("ALTER TABLE game_rooms ADD COLUMN enabled INTEGER DEFAULT 1")
        except sqlite3.OperationalError:
            pass

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS game_settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TEXT
            )
        """)
        cursor.execute("INSERT OR IGNORE INTO game_settings (key, value, updated_at) VALUES ('commission', '20', datetime('now'))")
        cursor.execute("INSERT OR IGNORE INTO game_settings (key, value, updated_at) VALUES ('winning_pattern', '\"1\"', datetime('now'))")
        cursor.execute("INSERT OR IGNORE INTO game_settings (key, value, updated_at) VALUES ('countdown', '60', datetime('now'))")
        
        conn.commit()
    logger.info("SQLite database initialized at: %s", DB_PATH)

def get_game_setting(key: str, default: Any = None) -> Any:
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute('SELECT value FROM game_settings WHERE key = ?', (key,))
            row = cursor.fetchone()
            if row and row['value'] is not None:
                try:
                    return json.loads(row['value'])
                except Exception:
                    return row['value']
    except Exception:
        pass
    return default

def set_game_setting(key: str, value: Any) -> None:
    now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
    val_str = json.dumps(value) if not isinstance(value, str) else value
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                'INSERT INTO game_settings (key, value, updated_at) VALUES (?, ?, ?) '
                'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
                (key, val_str, now)
            )
            conn.commit()
    except Exception as e:
        logger.error(f"Error setting game_settings {key}: {e}")

def get_all_game_settings() -> Dict[str, Any]:
    settings = {
        'commission': 20,
        'winning_pattern': '1',
        'countdown': 60
    }
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute('SELECT key, value FROM game_settings')
            rows = cursor.fetchall()
            for r in rows:
                try:
                    settings[r['key']] = json.loads(r['value'])
                except Exception:
                    settings[r['key']] = r['value']
    except Exception:
        pass
    return settings

def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def get_or_create_user(user_id: int, username: str = "", first_name: str = "", last_name: str = "") -> Dict[str, Any]:
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    is_admin = is_admin_check(user_id, username)
    user_role = "admin" if is_admin else "player"

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        if not row:
            initial_balance = 0.0  # Balance starts at 0 — admin must add funds manually
            initial_verified = 1  # Verified by default for seamless multi-device play
            cursor.execute("""
                INSERT INTO users (id, username, first_name, last_name, role, balance, bonus_balance, bonus_claimed, is_verified, status, registered_at, last_active)
                VALUES (?, ?, ?, ?, ?, ?, 0.0, 0, ?, 'active', ?, ?)
            """, (user_id, username or "", first_name or "", last_name or "", user_role, initial_balance, initial_verified, now, now))
            conn.commit()
            cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
        else:
            # Keep admin role if recognized
            current_role = "admin" if (is_admin or row["role"] == "admin") else row["role"]
            cursor.execute("""
                UPDATE users SET username = ?, first_name = ?, last_name = ?, role = ?, last_active = ?
                WHERE id = ?
            """, (username or row["username"], first_name or row["first_name"], last_name or row["last_name"], current_role, now, user_id))
            conn.commit()
            cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
        return dict(row)

def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        return dict(row) if row else None

def get_user_transactions(user_id: int) -> List[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10", (user_id,))
        rows = cursor.fetchall()
        return [dict(r) for r in rows]

def export_admin_players() -> None:
    """Exports regular players to players-data.js so Admin Panel displays them for the super administrator."""
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            # Verified regular players
            cursor.execute("SELECT * FROM users WHERE is_verified = 1 AND role = 'player' ORDER BY registered_at DESC")
            rows = cursor.fetchall()

            # Find designated admin record if present
            cursor.execute("SELECT * FROM users WHERE role = 'admin' LIMIT 1")
            admin_row = cursor.fetchone()

        players_list = []
        for r in rows:
            uid = r["id"]
            uname = r["username"]
            fname = r["first_name"] or ""
            lname = r["last_name"] or ""
            full_name = f"{fname} {lname}".strip() or (f"@{uname}" if uname else f"Player {uid}")
            display_user = f"@{uname}" if uname else f"ID: {uid}"
            phone = r["phone_number"] or "N/A"
            bal = float(r["balance"] or 0.0)

            players_list.append({
                "id": f"TG-{uid}",
                "userId": uid,
                "name": full_name,
                "username": display_user,
                "email": f"{uname or uid}@t.me",
                "phone": phone,
                "balance": bal,
                "games": 0,
                "lastActive": "Just now",
                "status": "active" if r["status"] == "active" else r["status"],
                "avatar": "blue",
                "note": f"Telegram Verified Player (TG ID: {uid})",
            })

        admin_uname = (admin_row["username"] if (admin_row and admin_row["username"]) else (ADMIN_USERNAMES[0] if ADMIN_USERNAMES else "0999909474"))
        admin_uname_disp = admin_uname if (admin_uname.startswith("@") or admin_uname.isdigit() or admin_uname.startswith("+")) else f"@{admin_uname}"

        admin_data = {
            "name": (f"{admin_row['first_name'] or ''} {admin_row['last_name'] or ''}".strip() or "0999909474") if admin_row else "0999909474",
            "username": admin_uname_disp,
            "phone": (admin_row["phone_number"] if admin_row and admin_row["phone_number"] else (ADMIN_PHONES[0] if ADMIN_PHONES else "0999909474")),
            "role": "Super administrator"
        }
        # Check if custom settings exist in data/payment_settings.json
        custom_pm_file = os.path.join(DB_DIR, "payment_settings.json")
        payment_methods_data = PAYMENT_METHODS
        if os.path.exists(custom_pm_file):
            try:
                with open(custom_pm_file, "r", encoding="utf-8") as pf:
                    custom_pm = json.load(pf)
                    payment_methods_data = {k: dict(v) for k, v in PAYMENT_METHODS.items()}
                    for k, v in custom_pm.items():
                        if k in payment_methods_data and isinstance(v, dict):
                            payment_methods_data[k].update(v)
            except Exception:
                pass

        # Format JS content with players list, admin profile, and deposit accounts
        js_content = (
            "/* Generated by Lucky Bingo Bot. Live verified player records for Admin Panel. */\n"
            '"use strict";\n'
            f"window.LUCKY_BINGO_ADMIN = {json.dumps(admin_data, ensure_ascii=False, indent=2)};\n"
            f"window.LUCKY_BINGO_PAYMENT_METHODS = {json.dumps(payment_methods_data, ensure_ascii=False, indent=2)};\n"
            f"window.LUCKY_BINGO_PLAYERS = {json.dumps(players_list, ensure_ascii=False, indent=2)};\n"
        )

        with open(PLAYERS_DATA_JS, "w", encoding="utf-8") as f:
            f.write(js_content)

        with open(PLAYERS_JSON, "w", encoding="utf-8") as f:
            json.dump({"admin": admin_data, "payment_methods": payment_methods_data, "players": players_list}, f, ensure_ascii=False, indent=2)

        # Mirror copy if directory exists
        if os.path.exists(MIRROR_DIR):
            try:
                with open(MIRROR_PLAYERS_DATA_JS, "w", encoding="utf-8") as f:
                    f.write(js_content)
            except Exception:
                pass

        logger.info("Admin players exported: %d verified players.", len(players_list))
    except Exception as e:
        logger.error("Error exporting admin players: %s", e)

# ==============================================================================
# GAME ENGINE (IN-MEMORY STATE MANAGER)
# ==============================================================================
class GameEngine:
    """Server-side game state manager for all bingo rooms."""
    
    def __init__(self):
        self.lock = threading.Lock()
        self._call_timers = {}  # room_id -> timer thread
        self._bot_players = {}  # room_id -> list of bot player dicts
    
    def get_room_state(self, room_id):
        """Get the current state of a room."""
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute('SELECT * FROM game_rooms WHERE id = ?', (room_id,))
            room = cursor.fetchone()
            if not room:
                return None
            
            round_id = room['round_id']
            
            # Get players
            cursor.execute('SELECT rp.user_id, rp.card_ids, u.username, u.first_name FROM room_players rp JOIN users u ON rp.user_id = u.id WHERE rp.room_id = ? AND rp.round_id = ?', (room_id, round_id))
            players = [dict(row) for row in cursor.fetchall()]
            
            # Get calls
            cursor.execute('SELECT number, call_index FROM game_calls WHERE room_id = ? AND round_id = ? ORDER BY call_index', (room_id, round_id))
            calls = [row['number'] for row in cursor.fetchall()]

            bot_players = []
            round_result = self.get_round_result(room_id)

            # Calculate derash based on setting commission %
            comm_pct = float(get_game_setting('commission', 20))
            total_cards = sum(len(json.loads(p.get('card_ids', '[]') or '[]')) for p in players)
            total_pot = max(1, total_cards) * int(room_id)
            derash = max(float(room_id), round(total_pot * (1.0 - comm_pct / 100.0), 2))
            winning_pattern = str(get_game_setting('winning_pattern', '1'))

            now_ts = time.time()
            cd_ends = float(room['countdown_ends_at'] or 0)
            cd_rem = max(0, int(round(cd_ends - now_ts))) if (room['status'] == 'countdown' and cd_ends > 0) else 0

            return {
                'room_id': room_id,
                'stake': int(room_id),
                'status': room['status'],
                'round_id': round_id,
                'countdown_ends_at': cd_ends,
                'countdown_remaining': cd_rem,
                'server_time': now_ts,
                'players': players,
                'bot_players': [],
                'calls': calls,
                'last_result': round_result,
                'player_count': len(players),
                'total_cards': total_cards,
                'derash': derash,
                'commission_pct': comm_pct,
                'winning_pattern': winning_pattern,
            }
    
    def join_room(self, room_id, user_id, card_ids):
        """Join or update a player's cards using the server-owned wallet and round."""
        with self.lock:
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT * FROM game_rooms WHERE id = ?', (room_id,))
                room = cursor.fetchone()
                if not room:
                    return {'error': 'Room not found'}
                if room['status'] == 'live':
                    return {'error': 'Game in progress, please wait'}

                card_ids = list(dict.fromkeys(card_ids or []))
                if not card_ids or len(card_ids) > 50 or any(
                    not isinstance(card_id, int) or card_id < 1 or card_id > 1000
                    for card_id in card_ids
                ):
                    return {'error': 'Choose up to 50 valid cards'}

                stake = int(room_id)
                round_id = room['round_id']
                cursor.execute(
                    'SELECT card_ids FROM room_players WHERE room_id = ? AND round_id = ?',
                    (room_id, round_id),
                )
                taken_cards = set()
                for row in cursor.fetchall():
                    try:
                        taken_cards.update(json.loads(row['card_ids'] or '[]'))
                    except (TypeError, ValueError):
                        pass

                cursor.execute(
                    'SELECT card_ids FROM room_players WHERE room_id = ? AND user_id = ? AND round_id = ?',
                    (room_id, user_id, round_id),
                )
                existing = cursor.fetchone()
                old_cards = []
                if existing:
                    try:
                        old_cards = json.loads(existing['card_ids'] or '[]')
                    except (TypeError, ValueError):
                        old_cards = []
                if any(card_id in taken_cards and card_id not in old_cards for card_id in card_ids):
                    return {'error': 'One of those cards is already taken'}

                old_cost = stake * len(old_cards)
                new_cost = stake * len(card_ids)
                delta = new_cost - old_cost
                if delta > 0:
                    cursor.execute(
                        'UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?',
                        (delta, user_id, delta),
                    )
                    if cursor.rowcount == 0:
                        return {'error': 'Insufficient balance'}
                elif delta < 0:
                    cursor.execute('UPDATE users SET balance = balance + ? WHERE id = ?', (-delta, user_id))

                now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
                if existing:
                    cursor.execute(
                        'UPDATE room_players SET card_ids = ?, joined_at = ? WHERE room_id = ? AND user_id = ? AND round_id = ?',
                        (json.dumps(card_ids), now, room_id, user_id, round_id),
                    )
                else:
                    cursor.execute(
                        'INSERT INTO room_players (room_id, user_id, round_id, card_ids, joined_at) VALUES (?, ?, ?, ?, ?)',
                        (room_id, user_id, round_id, json.dumps(card_ids), now),
                    )
                cursor.execute('SELECT balance FROM users WHERE id = ?', (user_id,))
                new_balance = float(cursor.fetchone()['balance'] or 0.0)
                conn.commit()

            self._check_start_countdown(room_id)
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT status, countdown_ends_at FROM game_rooms WHERE id = ?', (room_id,))
                current_room = cursor.fetchone()

            now_ts = time.time()
            rm_status = current_room['status'] if current_room else 'countdown'
            cd_ends = float(current_room['countdown_ends_at'] or 0) if current_room else 0
            cd_rem = max(0, int(round(cd_ends - now_ts))) if (rm_status == 'countdown' and cd_ends > 0) else 0

            return {
                'ok': True,
                'updated': bool(existing),
                'cost': new_cost,
                'balance': new_balance,
                'round_id': round_id,
                'status': rm_status,
                'countdown_ends_at': cd_ends,
                'countdown_remaining': cd_rem,
                'server_time': now_ts,
            }
    
    def _check_start_countdown(self, room_id, conn=None):
        """Start one shared countdown after a real player joins."""
        def _do_check(connection):
            cursor = connection.cursor()
            cursor.execute('SELECT * FROM game_rooms WHERE id = ?', (room_id,))
            room = cursor.fetchone()
            if not room or room['status'] != 'open':
                return
            
            cursor.execute('SELECT COUNT(*) as cnt FROM room_players WHERE room_id = ? AND round_id = ?', (room_id, room['round_id']))
            real_count = cursor.fetchone()['cnt']
            bot_count = len(self._bot_players.get(room_id, []))
            
            if real_count >= 1:  # When at least 1 real player has joined with cards, start countdown
                countdown_secs = 60
                try:
                    custom_cd = int(get_game_setting('countdown', 60))
                    if custom_cd >= 10:
                        countdown_secs = custom_cd
                except Exception:
                    countdown_secs = 60
                ends_at = time.time() + countdown_secs
                now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
                cursor.execute('UPDATE game_rooms SET status = ?, countdown_ends_at = ?, updated_at = ? WHERE id = ?', ('countdown', ends_at, now, room_id))
                connection.commit()
                
                # Schedule game start
                self._schedule_game_start(room_id, countdown_secs)
        
        if conn:
            _do_check(conn)
        else:
            with get_db_connection() as new_conn:
                _do_check(new_conn)
    
    def _add_bot_players(self, room_id):
        """No-op: Only real players are allowed in games."""
        self._bot_players[room_id] = []
    
    def _schedule_game_start(self, room_id, delay):
        """Schedule the live game to start after countdown."""
        if room_id in self._call_timers:
            self._call_timers[room_id].cancel()
        
        timer = threading.Timer(delay, self._start_live_game, args=[room_id])
        timer.daemon = True
        timer.start()
        self._call_timers[room_id] = timer
    
    def _start_live_game(self, room_id):
        """Transition the shared room to live and start its single call sequence."""
        with self.lock:
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT status, round_id FROM game_rooms WHERE id = ?', (room_id,))
                room = cursor.fetchone()
                if not room or room['status'] != 'countdown':
                    return
                cursor.execute('SELECT COUNT(*) as cnt FROM room_players WHERE room_id = ? AND round_id = ?', (room_id, room['round_id']))
                player_cnt = cursor.fetchone()['cnt']
                if player_cnt == 0:
                    cursor.execute('UPDATE game_rooms SET status = ?, countdown_ends_at = 0 WHERE id = ?', ('open', room_id))
                    conn.commit()
                    return
                now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
                cursor.execute('UPDATE game_rooms SET status = ?, updated_at = ? WHERE id = ?', ('live', now, room_id))
                conn.commit()

        # Only this server timer creates calls; every client reads the same rows.
        self._schedule_next_call(room_id)
    
    def _schedule_next_call(self, room_id):
        """Schedule the next number call with comfortable 3.6s pacing (1.6s + 2s)."""
        interval = 3.6
        try:
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT value FROM game_settings WHERE key = 'call_interval'")
                row = cursor.fetchone()
                if row and row['value']:
                    interval = float(row['value'])
        except Exception:
            pass
        timer = threading.Timer(interval, self._call_next_number, args=[room_id])
        timer.daemon = True
        timer.start()
        self._call_timers[room_id] = timer
    
    def _call_next_number(self, room_id):
        """Call the next bingo number for a room."""
        with self.lock:
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT * FROM game_rooms WHERE id = ? AND status = ?', (room_id, 'live'))
                room = cursor.fetchone()
                if not room:
                    return
                
                round_id = room['round_id']
                
                # Get already called numbers
                cursor.execute('SELECT number FROM game_calls WHERE room_id = ? AND round_id = ?', (room_id, round_id))
                called_numbers = {row['number'] for row in cursor.fetchall()}
                
                # Get remaining numbers
                all_numbers = list(range(1, 76))
                remaining = [n for n in all_numbers if n not in called_numbers]
                
                if not remaining:
                    # All numbers called, end round with no winner
                    self._end_round(room_id, conn, winner_id=None, winner_name='No Winner')
                    return
                
                # Pick next number
                next_num = random.choice(remaining)
                call_index = len(called_numbers)
                now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
                
                cursor.execute('INSERT INTO game_calls (room_id, round_id, call_index, number, called_at) VALUES (?, ?, ?, ?, ?)', (room_id, round_id, call_index, next_num, now))
                conn.commit()
                
                pass
        
        # Schedule next call
        self._schedule_next_call(room_id)
    
    def claim_bingo(self, room_id, user_id, card_id):
        """Validate a player's card against the server's called numbers."""
        try:
            card_id = int(card_id)
        except (TypeError, ValueError):
            return {'error': 'Invalid card'}

        card_catalog_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'card number.json')
        try:
            with open(card_catalog_path, 'r', encoding='utf-8') as card_file:
                card_values = json.load(card_file).get(str(card_id))
            if not isinstance(card_values, list) or len(card_values) != 25:
                return {'error': 'Card not found'}
        except (OSError, ValueError, TypeError):
            return {'error': 'Card data unavailable'}

        with self.lock:
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT * FROM game_rooms WHERE id = ? AND status = ?', (room_id, 'live'))
                room = cursor.fetchone()
                if not room:
                    return {'error': 'Game not in progress'}

                round_id = room['round_id']
                cursor.execute(
                    'SELECT number FROM game_calls WHERE room_id = ? AND round_id = ?',
                    (room_id, round_id),
                )
                called = {int(row['number']) for row in cursor.fetchall()}
                cursor.execute(
                    'SELECT rp.*, u.first_name, u.username FROM room_players rp '
                    'JOIN users u ON rp.user_id = u.id '
                    'WHERE rp.room_id = ? AND rp.user_id = ? AND rp.round_id = ?',
                    (room_id, user_id, round_id),
                )
                player = cursor.fetchone()
                if not player:
                    return {'error': 'You are not in this game'}

                try:
                    owned_cards = {int(value) for value in json.loads(player['card_ids'] or '[]')}
                except (TypeError, ValueError):
                    owned_cards = set()
                if card_id not in owned_cards:
                    return {'error': 'Card is not registered to you'}

                # The center square is free. All other cells must have been
                # called by the one server-owned number sequence.
                winning_lines = [
                    [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14],
                    [15, 16, 17, 18, 19], [20, 21, 22, 23, 24],
                    [0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22],
                    [3, 8, 13, 18, 23], [4, 9, 14, 19, 24],
                    [0, 6, 12, 18, 24], [4, 8, 12, 16, 20],
                ]
                def cell_is_hit(index):
                    return index == 12 or int(card_values[index]) in called

                if not any(all(cell_is_hit(index) for index in line) for line in winning_lines):
                    return {'error': 'Bingo is not complete'}

                winner_name = player['first_name'] or player['username'] or 'Player'
                self._end_round(room_id, conn, winner_id=user_id, winner_name=winner_name, card_id=card_id, winning_pattern='LINE')
                res = self.get_round_result(room_id)
                prize = res.get('prize', 0) if res else 0
                return {'ok': True, 'winner': winner_name, 'prize': prize, 'card_id': int(card_id)}
    
    def _end_round(self, room_id, conn, winner_id=None, winner_name='', is_bot=False, card_id=None, winning_pattern='LINE'):
        """End a round, distribute derash prize to the only 1 winner, reset room."""
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM game_rooms WHERE id = ?', (room_id,))
        room = cursor.fetchone()
        if not room:
            return
        
        round_id = room['round_id']
        stake = int(room_id)
        
        # Count total cards played in this round
        cursor.execute('SELECT user_id, card_ids FROM room_players WHERE room_id = ? AND round_id = ?', (room_id, round_id))
        real_players = cursor.fetchall()
        
        total_cards = sum(len(json.loads(p['card_ids'])) for p in real_players)
        if total_cards <= 0:
            total_cards = 1
        total_pot = total_cards * stake
        
        # Deduct percentage set in settings (Commission)
        try:
            comm_pct = float(get_game_setting('commission', 20))
        except (ValueError, TypeError):
            comm_pct = 20.0
        commission_rate = comm_pct / 100.0
        commission_amount = total_pot * commission_rate
        
        # Derash: remaining pot after deducting setting percent (always given 100% to the 1 winner)
        derash = max(float(stake), round(total_pot - commission_amount, 2))
        
        # Award derash to the ONLY 1 winner if real player
        if winner_id and not is_bot:
            cursor.execute('UPDATE users SET balance = balance + ? WHERE id = ?', (derash, winner_id))
            # Record winning transaction in history
            tx_id = f"WIN-{int(time.time())}-{random.randint(1000, 9999)}"
            now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
            cursor.execute(
                "INSERT INTO transactions (id, user_id, type, method, amount, phone_number, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (tx_id, winner_id, 'win', 'Bingo Derash Win', derash, f"Room {stake} ETB · Round #{round_id}", 'completed', now)
            )
            conn.commit()
            export_admin_players()
        
        # Cancel any pending timers
        if room_id in self._call_timers:
            self._call_timers[room_id].cancel()
            del self._call_timers[room_id]
        
        # Reset room for next round
        now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
        new_round = round_id + 1
        cursor.execute('UPDATE game_rooms SET status = ?, round_id = ?, countdown_ends_at = 0, updated_at = ? WHERE id = ?', ('open', new_round, now, room_id))
        conn.commit()
        
        # Store the round result in memory briefly for clients to see
        self._round_results = getattr(self, '_round_results', {})
        self._round_results[room_id] = {
            'winner_name': winner_name,
            'winner_id': winner_id,
            'card_id': int(card_id) if card_id is not None else None,
            'winning_pattern': winning_pattern or 'LINE',
            'is_bot': is_bot,
            'prize': derash,
            'round_id': round_id,
            'ended_at': time.time()
        }
        
        # Clear bot players
        self._bot_players.pop(room_id, None)
    
    def get_round_result(self, room_id):
        """Get the most recent round result if any (expires after 45 seconds)."""
        results = getattr(self, '_round_results', {})
        result = results.get(room_id)
        if result and time.time() - result['ended_at'] < 45:
            return result
        return None
    
    def leave_room(self, room_id, user_id):
        """Player leaves a room. Refund if game hasn't started."""
        with self.lock:
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT * FROM game_rooms WHERE id = ?', (room_id,))
                room = cursor.fetchone()
                if not room:
                    return {'error': 'Room not found'}
                
                round_id = room['round_id']
                
                # Only refund if game is still open/countdown
                if room['status'] in ('open', 'countdown'):
                    cursor.execute('SELECT card_ids FROM room_players WHERE room_id = ? AND user_id = ? AND round_id = ?', (room_id, user_id, round_id))
                    player = cursor.fetchone()
                    if player:
                        card_ids = json.loads(player['card_ids'])
                        refund = int(room_id) * len(card_ids)
                        cursor.execute('UPDATE users SET balance = balance + ? WHERE id = ?', (refund, user_id))
                
                cursor.execute('DELETE FROM room_players WHERE room_id = ? AND user_id = ? AND round_id = ?', (room_id, user_id, round_id))
                conn.commit()
                return {'ok': True}

    def admin_pause_room(self, room_id, paused=True):
        """Admin pauses or resumes a room."""
        with self.lock:
            with get_db_connection() as conn:
                cursor = conn.cursor()
                status = 'paused' if paused else 'open'
                now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
                cursor.execute('UPDATE game_rooms SET status = ?, updated_at = ? WHERE id = ?', (status, now, str(room_id)))
                conn.commit()
                return {'ok': True, 'room_id': str(room_id), 'status': status}

    def admin_reset_room(self, room_id):
        """Admin resets a room to open waiting state and refunds players."""
        with self.lock:
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT * FROM game_rooms WHERE id = ?', (str(room_id),))
                room = cursor.fetchone()
                if not room:
                    return {'error': 'Room not found'}
                round_id = room['round_id']
                stake = int(room_id)
                # Refund any real players in this round
                cursor.execute('SELECT user_id, card_ids FROM room_players WHERE room_id = ? AND round_id = ?', (str(room_id), round_id))
                for row in cursor.fetchall():
                    try:
                        cards = json.loads(row['card_ids'] or '[]')
                        refund = stake * len(cards)
                        if refund > 0:
                            cursor.execute('UPDATE users SET balance = balance + ? WHERE id = ?', (refund, row['user_id']))
                    except Exception:
                        pass
                if str(room_id) in self._call_timers:
                    self._call_timers[str(room_id)].cancel()
                    del self._call_timers[str(room_id)]
                self._bot_players.pop(str(room_id), None)
                new_round = round_id + 1
                now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
                cursor.execute('UPDATE game_rooms SET status = ?, round_id = ?, countdown_ends_at = 0, updated_at = ? WHERE id = ?', ('open', new_round, now, str(room_id)))
                conn.commit()
                return {'ok': True, 'room_id': str(room_id), 'status': 'open', 'round_id': new_round}

    def admin_force_countdown(self, room_id, countdown_secs=60):
        """Admin forces countdown to start immediately."""
        with self.lock:
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT * FROM game_rooms WHERE id = ?', (str(room_id),))
                room = cursor.fetchone()
                if not room or room['status'] not in ('open', 'countdown'):
                    return {'error': 'Room cannot be started (must be open or in countdown)'}
                ends_at = time.time() + countdown_secs
                now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
                cursor.execute('UPDATE game_rooms SET status = ?, countdown_ends_at = ?, updated_at = ? WHERE id = ?', ('countdown', ends_at, now, str(room_id)))
                conn.commit()
                self._schedule_game_start(str(room_id), countdown_secs)
                return {'ok': True, 'room_id': str(room_id), 'status': 'countdown', 'ends_at': ends_at}

    def admin_toggle_room_enabled(self, room_id, enabled=None):
        """Admin toggles a room enabled/disabled."""
        with self.lock:
            with get_db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute('SELECT enabled FROM game_rooms WHERE id = ?', (str(room_id),))
                row = cursor.fetchone()
                current_enabled = 1
                if row and 'enabled' in row.keys() and row['enabled'] is not None:
                    current_enabled = int(row['enabled'])
                new_val = (1 if enabled else 0) if enabled is not None else (0 if current_enabled == 1 else 1)
                now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
                cursor.execute('UPDATE game_rooms SET enabled = ?, updated_at = ? WHERE id = ?', (new_val, now, str(room_id)))
                conn.commit()
                return {'ok': True, 'room_id': str(room_id), 'enabled': bool(new_val)}

# Create global game engine instance
game_engine = GameEngine()

# ==============================================================================
# SYSTEM DATA: PAYMENT METHODS (from Lucky Bingo Core)
# ==============================================================================
PAYMENT_METHODS: Dict[str, Dict[str, Any]] = {
    "Telebirr": {
        "name": "Telebirr",
        "account_name": "Africa Bingo",
        "account_number": "0999909474",
        "min_amount": 50,
        "bonus": "ከ 100 ETB በላይ 20% ተጨማሪ ቦነስ",
    },
    "CBE Birr": {
        "name": "CBE Birr",
        "account_name": "Africa Bingo CBE Birr",
        "account_number": "1000 000 000",
        "min_amount": 50,
        "bonus": "ከ 100 ETB በላይ 20% ተጨማሪ ቦነስ",
    },
    "M-Pesa": {
        "name": "M-Pesa",
        "account_name": "Africa Bingo M-Pesa",
        "account_number": "0700 000 000",
        "min_amount": 50,
        "bonus": "ከ 100 ETB በላይ 20% ተጨማሪ ቦነስ",
    },
}

def get_payment_methods() -> Dict[str, Dict[str, Any]]:
    """Retrieves payment methods, merging custom receiving numbers if configured."""
    custom_pm_file = os.path.join(DB_DIR, "payment_settings.json")
    if os.path.exists(custom_pm_file):
        try:
            with open(custom_pm_file, "r", encoding="utf-8") as pf:
                custom_pm = json.load(pf)
                merged = {k: dict(v) for k, v in PAYMENT_METHODS.items()}
                for k, v in custom_pm.items():
                    if k in merged and isinstance(v, dict):
                        merged[k].update(v)
                return merged
        except Exception:
            pass
    return PAYMENT_METHODS

# ==============================================================================
# KEYBOARD BUILDERS
# ==============================================================================
def get_main_keyboard(is_admin_user: bool = False, user_id: int = 0) -> InlineKeyboardMarkup:
    """Exact 6-row main inline keyboard, plus Admin Controls row if authorized."""
    web_app_url = get_game_web_url(is_admin_user=is_admin_user, user_id=user_id)

    keyboard = [
        # Row 1: Full-width Web App button
        [
            InlineKeyboardButton(
                text="Play Games 🎮",
                web_app=WebAppInfo(url=web_app_url),
            )
        ],
        # Row 2: Deposit & Withdraw
        [
            InlineKeyboardButton(text="Deposit 💰", callback_data="deposit"),
            InlineKeyboardButton(text="Withdraw 💰", callback_data="withdraw"),
        ],
        # Row 3: Transfer & My Profile
        [
            InlineKeyboardButton(text="Transfer ↔️", callback_data="transfer"),
            InlineKeyboardButton(text="My Profile 👤", callback_data="profile"),
        ],
        # Row 4: Transactions & Balance
        [
            InlineKeyboardButton(text="Transactions 📜", callback_data="transactions"),
            InlineKeyboardButton(text="Balance 💰", callback_data="balance"),
        ],
        # Row 5: Join Group & Contact Us
        [
            InlineKeyboardButton(text="Join Group ↗️", url=GROUP_URL),
            (
                InlineKeyboardButton(text="Contact Us", url=CONTACT_URL)
                if CONTACT_URL.startswith("http")
                else InlineKeyboardButton(text="Contact Us", callback_data="contact_us")
            ),
        ],
        # Row 6: Refer & Earn
        [
            InlineKeyboardButton(text="Refer & Earn 🎁", callback_data="refer_earn"),
        ],
    ]

    # Row 7: Only shown to authorized administrator
    if is_admin_user:
        keyboard.append([
            InlineKeyboardButton(text="🛡️ Admin Controls (የአስተዳዳሪ ክፍል)", callback_data="admin_dashboard")
        ])

    return InlineKeyboardMarkup(keyboard)

def get_contact_request_keyboard() -> ReplyKeyboardMarkup:
    """One-tap contact share reply keyboard matching reference UI in Amharic."""
    button = KeyboardButton(text="📱 ስልክ ቁጥርዎን ያጋሩ", request_contact=True)
    return ReplyKeyboardMarkup([[button]], resize_keyboard=True, one_time_keyboard=True)

def get_main_reply_keyboard(is_admin_user: bool = False) -> ReplyKeyboardMarkup:
    """Main persistent reply keyboard matching the 9-button layout in reference UI."""
    keyboard = [
        [
            KeyboardButton(text="🎮 ቢንጎ ተጫወት", web_app=WebAppInfo(url=get_game_web_url())),
            KeyboardButton(text="🎁 ፕሮሞ ኮድ"),
        ],
        [
            KeyboardButton(text="💰 ገቢ ለማድረግ"),
            KeyboardButton(text="💸 ወጪ ለማድረግ"),
        ],
        [
            KeyboardButton(text="🔗 ጋብዝ & አግኝ"),
            KeyboardButton(text="👤 ፕሮፋይል & ሂሳብ"),
        ],
        [
            KeyboardButton(text="🆘 እርዳታ"),
            KeyboardButton(text="🌐 ቋንቋ / Language"),
        ],
        [
            KeyboardButton(text="📢 አጀንት ፕሮሞተር"),
        ],
    ]
    return ReplyKeyboardMarkup(keyboard, resize_keyboard=True, is_persistent=True)

def get_deposit_methods_keyboard() -> InlineKeyboardMarkup:
    """Deposit payment methods pulled directly from the system."""
    keyboard = []
    methods = get_payment_methods()
    for method_name in methods:
        keyboard.append([
            InlineKeyboardButton(text=method_name, callback_data=f"dep_{method_name}")
        ])
    keyboard.append([
        InlineKeyboardButton(text="« ወደ ዋናው ማውጫ (Back)", callback_data="back_to_menu")
    ])
    return InlineKeyboardMarkup(keyboard)

def get_withdraw_methods_keyboard() -> InlineKeyboardMarkup:
    """Withdrawal payment methods pulled directly from the system."""
    keyboard = []
    methods = get_payment_methods()
    for method_name in methods:
        keyboard.append([
            InlineKeyboardButton(text=method_name, callback_data=f"wth_{method_name}")
        ])
    keyboard.append([
        InlineKeyboardButton(text="« ወደ ዋናው ማውጫ (Back)", callback_data="back_to_menu")
    ])
    return InlineKeyboardMarkup(keyboard)

# ==============================================================================
# USER DASHBOARD & GREETING
# ==============================================================================
async def send_user_dashboard(update: Update, user, profile: dict, is_admin: bool) -> None:
    """Sends greeting, balance summary, photo banner, and persistent reply keyboard."""
    msg = update.effective_message
    if not msg:
        return

    uname = f"@{user.username}" if user.username else (user.first_name or f"Player {user.id}")
    bal = float(profile.get("balance", 0.0))
    bal_str = f"{int(bal)}" if bal.is_integer() else f"{bal:.2f}"

    caption = (
        f"ሰላም {uname}!\n"
        f"የጨዋታ ሂሳብ: {bal_str} ETB\n"
        f"የአሸናፊነት ሂሳብ: 0 ETB"
    )

    reply_kb = get_main_reply_keyboard(is_admin_user=is_admin)
    banner_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "welcome_banner.png")

    if os.path.exists(banner_path):
        try:
            with open(banner_path, "rb") as photo_file:
                await msg.reply_photo(
                    photo=photo_file,
                    caption=caption,
                    reply_markup=reply_kb
                )
                return
        except Exception as e:
            logger.warning("Could not send banner photo: %s", e)

    await msg.reply_text(
        text=caption,
        reply_markup=reply_kb
    )

# ==============================================================================
# COMMAND & FLOW HANDLERS
# ==============================================================================
async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handles /start command with verification check and bonus claim prompt."""
    user = update.effective_user
    if not user:
        return

    profile = get_or_create_user(
        user_id=user.id,
        username=user.username or "",
        first_name=user.first_name or "",
        last_name=user.last_name or "",
    )

    is_admin = is_admin_check(user.id, user.username or "", profile.get("phone_number", ""))

    # If the user has not verified their phone number and is not admin, ask to share phone in Amharic
    if not profile.get("is_verified") and not is_admin:
        prompt_text = (
            "👋 *እንኳን ወደ Africa Bingo በደህና መጡ!*\n\n"
            "ለመመዝገብ እና የ **10 ETB** ቦነስዎን ለማግኘት እባክዎ ከታች ያለውን **'📱 ስልክ ቁጥርዎን ያጋሩ'** የሚለውን ቁልፍ ይጫኑ:"
        )
        if update.effective_message:
            await update.effective_message.reply_text(
                text=prompt_text,
                reply_markup=get_contact_request_keyboard(),
                parse_mode="Markdown",
            )
        return

    # If already verified or admin, send dashboard
    await send_user_dashboard(update, user, profile, is_admin)

# ==============================================================================
# CONTACT SHARING & ANTI-FRAUD BONUS HANDLER
# ==============================================================================
async def contact_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handles phone contact sharing, grants 10 ETB welcome bonus for new registers."""
    user = update.effective_user
    message = update.effective_message
    if not user or not message or not message.contact:
        return

    contact = message.contact

    # 1. Anti-Spoofing: Ensure shared contact belongs to current Telegram user
    if contact.user_id != user.id:
        await message.reply_text(
            text="⚠️ *ስህተት:* እባክዎ የራስዎን ስልክ ቁጥር ብቻ ያጋሩ! የሌላ ሰውን ኮንታክት ማጋራት አይፈቀድም።",
            reply_markup=get_contact_request_keyboard(),
            parse_mode="Markdown",
        )
        return

    raw_phone = contact.phone_number
    phone = normalize_phone(raw_phone)
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    # Check admin privilege
    is_admin = is_admin_check(user.id, user.username or "", phone)
    assigned_role = "admin" if is_admin else "player"

    with get_db_connection() as conn:
        cursor = conn.cursor()

        cursor.execute("SELECT * FROM users WHERE phone_number = ?", (phone,))
        existing_phone_user = cursor.fetchone()

        cursor.execute("SELECT * FROM users WHERE id = ?", (user.id,))
        current_user = cursor.fetchone()

        phone_already_used = existing_phone_user is not None and existing_phone_user["id"] != user.id
        already_claimed = (
            (existing_phone_user and existing_phone_user["bonus_claimed"] == 1) or
            (current_user and current_user["bonus_claimed"] == 1)
        )

        if already_claimed or phone_already_used:
            # Phone has already been registered / bonus already consumed
            cursor.execute("""
                UPDATE users
                SET phone_number = ?, role = ?, is_verified = 1, last_active = ?
                WHERE id = ?
            """, (phone, assigned_role, now, user.id))
            conn.commit()
            bonus_granted = False
        else:
            # Brand new registration: grant 10 ETB Welcome Bonus
            bonus_granted = True
            cursor.execute("""
                UPDATE users
                SET phone_number = ?, role = ?, balance = balance + 10.0, bonus_claimed = 1, is_verified = 1, last_active = ?
                WHERE id = ?
            """, (phone, assigned_role, now, user.id))

            # Record bonus transaction
            tx_id = f"BONUS-{int(time.time())}-{random.randint(1000, 9999)}"
            cursor.execute("""
                INSERT INTO transactions (id, user_id, type, method, amount, phone_number, status, created_at)
                VALUES (?, ?, 'bonus', 'Welcome Bonus', 10.0, ?, 'completed', ?)
            """, (tx_id, user.id, phone, now))
            conn.commit()

        cursor.execute("SELECT * FROM users WHERE id = ?", (user.id,))
        updated_profile = cursor.fetchone()

    # Export to admin players data immediately so admin sees new player
    export_admin_players()

    uname = f"@{user.username}" if user.username else (user.first_name or f"Player {user.id}")

    # Message 1 (Confirmation)
    await message.reply_text(
        text=f"እንኳን ደስ አለዎት {uname}! ምዝገባው ተጠናቋል። አሁን መጫወት ይችላሉ።"
    )

    # Message 2 (Dashboard banner with balances & persistent reply keyboard)
    bal = float(updated_profile["balance"] or 0.0) if updated_profile else (10.0 if bonus_granted else 0.0)
    bal_str = f"{int(bal)}" if bal.is_integer() else f"{bal:.2f}"

    caption = (
        f"ሰላም {uname}!\n"
        f"የጨዋታ ሂሳብ: {bal_str} ETB\n"
        f"የአሸናፊነት ሂሳብ: 0 ETB"
    )

    reply_kb = get_main_reply_keyboard(is_admin_user=is_admin)
    banner_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "welcome_banner.png")

    if os.path.exists(banner_path):
        try:
            with open(banner_path, "rb") as photo_file:
                await message.reply_photo(
                    photo=photo_file,
                    caption=caption,
                    reply_markup=reply_kb
                )
                return
        except Exception as e:
            logger.warning("Could not send banner photo: %s", e)

    await message.reply_text(
        text=caption,
        reply_markup=reply_kb
    )

# ==============================================================================
# PERSISTENT REPLY KEYBOARD BUTTON ROUTER
# ==============================================================================
async def menu_text_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handles text messages from the persistent reply keyboard buttons."""
    message = update.effective_message
    user = update.effective_user
    if not message or not message.text or not user:
        return

    text = message.text.strip()
    profile = get_or_create_user(user.id, user.username or "", user.first_name or "", user.last_name or "")
    is_admin = is_admin_check(user.id, user.username or "", profile.get("phone_number", ""))
    reply_kb = get_main_reply_keyboard(is_admin_user=is_admin)

    if "🎮" in text or "ቢንጎ ተጫወት" in text:
        web_url = get_game_web_url()
        kb = InlineKeyboardMarkup([
            [InlineKeyboardButton(text="🎮 ቢንጎ አሁን ተጫወት (Play)", web_app=WebAppInfo(url=web_url))]
        ])
        await message.reply_text(
            text="🎮 *Africa Bingo ጨዋታ ለመጀመር ከታች ያለውን ቁልፍ ይጫኑ:*",
            reply_markup=kb,
            parse_mode="Markdown"
        )
    elif "🎁" in text or "ፕሮሞ ኮድ" in text:
        context.user_data["waiting_promo"] = True
        await message.reply_text(
            text="🎁 *የፕሮሞ ኮድ ማስገቢያ*\n\nእባክዎ ያገኙትን የፕሮሞ ኮድ እዚህ ይላኩልን:",
            reply_markup=reply_kb,
            parse_mode="Markdown"
        )
    elif "💰" in text or "ገቢ ለማድረግ" in text:
        await deposit_flow(update, context)
    elif "💸" in text or "ወጪ ለማድረግ" in text:
        await withdraw_flow(update, context)
    elif "🔗" in text or "ጋብዝ & አግኝ" in text:
        try:
            bot_info = await context.bot.get_me()
            bot_username = bot_info.username or "AfricaBingoBot"
        except Exception:
            bot_username = "AfricaBingoBot"
        ref_link = f"https://t.me/{bot_username}?start=ref_{user.id}"
        await message.reply_text(
            text=(
                f"🔗 *የግብዣ ሊንክ (Referral Link)*\n\n"
                f"ጓደኞችዎ በእርስዎ ሊንክ ተመዝግበው ሲጫወቱ ተጨማሪ የኮሚሽን ቦነስ ያግኙ!\n\n"
                f"የእርስዎ ሊንክ:\n`{ref_link}`\n\n"
                f"ሊንኩን ለጓደኞችዎ ያጋሩ!"
            ),
            reply_markup=reply_kb,
            parse_mode="Markdown"
        )
    elif "👤" in text or "ፕሮፋይል & ሂሳብ" in text or "ፕሮፋይል" in text:
        phone = profile.get("phone_number", "ያልተረጋገጠ ⚠️")
        bal = float(profile.get("balance", 0.0))
        bonus_status = "የተወሰደ (10 ETB) ✅" if profile.get("bonus_claimed") else "ያልተወሰደ 🎁"
        await message.reply_text(
            text=(
                f"👤 *የተጠቃሚ መረጃ (Profile)*\n\n"
                f"🆔 *ID:* `{user.id}`\n"
                f"📱 *ስልክ ቁጥር:* `{phone}`\n"
                f"💰 *የጨዋታ ሂሳብ:* `{bal:.2f} ETB`\n"
                f"🏆 *የአሸናፊነት ሂሳብ:* `0.00 ETB`\n"
                f"🎁 *ቦነስ:* {bonus_status}\n"
                f"✅ *ሁኔታ:* {'የተረጋገጠ' if profile.get('is_verified') else 'ያልተረጋገጠ'}"
            ),
            reply_markup=reply_kb,
            parse_mode="Markdown"
        )
    elif "🆘" in text or "እርዳታ" in text:
        await message.reply_text(
            text=(
                "🆘 *የደንበኞች አገልግሎት እና እርዳታ*\n\n"
                "ጥያቄ ወይም እርዳታ ሲፈልጉ በTelegram ያነጋግሩን:\n"
                f"👉 {CONTACT_URL}\n"
                f"📢 ቻናላችን: {GROUP_URL}"
            ),
            reply_markup=reply_kb,
            parse_mode="Markdown"
        )
    elif "🌐" in text or "ቋንቋ" in text:
        await message.reply_text(
            text="🌐 ቋንቋ ተመርጧል: *አማርኛ (Amharic)* ✅",
            reply_markup=reply_kb,
            parse_mode="Markdown"
        )
    elif "📢" in text or "አጀንት" in text or "ኤጀንት" in text:
        await message.reply_text(
            text=(
                "📢 *የ Africa Bingo አጀንት ፕሮሞተር ፕሮግራም*\n\n"
                "ተጫዋቾችን በመጋበዝ በሳምንት እስከ 10,000+ ETB ማግኘት ይችላሉ!\n"
                f"ለበለጠ መረጃ ያነጋግሩን: {CONTACT_URL}"
            ),
            reply_markup=reply_kb,
            parse_mode="Markdown"
        )
    elif "🛡️" in text or "Admin Controls" in text:
        if is_admin:
            await admin_command(update, context)
        else:
            await message.reply_text("⛔ ይህን ለመጠቀም የአስተዳዳሪ (Admin) ፈቃድ የለዎትም።", reply_markup=reply_kb)
    else:
        if context.user_data.get("waiting_promo"):
            context.user_data["waiting_promo"] = False
            clean_code = text.upper().strip()
            if clean_code in ("AFRICA", "BINGO", "AFRICA10", "BONUS10"):
                await message.reply_text(
                    text="🎁 *እንኳን ደስ አለዎት! የ 10 ETB ፕሮሞ ኮድ ቦነስ ተጨምሮልዎታል።*",
                    reply_markup=reply_kb,
                    parse_mode="Markdown"
                )
            else:
                await message.reply_text(
                    text="❌ *ይቅርታ! ያስገቡት የፕሮሞ ኮድ ልክ አይደለም ወይም ጊዜው አልፏል።*",
                    reply_markup=reply_kb,
                    parse_mode="Markdown"
                )
        else:
            await message.reply_text(
                text="👋 *ሰላም! እባክዎ ከታች ካሉት አማራጮች አንዱን ይምረጡ:*",
                reply_markup=reply_kb,
                parse_mode="Markdown"
            )

# ==============================================================================
# ADMIN CONSOLE & CONTROLS (Only for designated admin)
# ==============================================================================
async def admin_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handles /admin command. Strictly protected for authorized administrators."""
    user = update.effective_user
    if not user:
        return

    profile = get_or_create_user(user.id, user.username or "", user.first_name or "", user.last_name or "")
    if not is_admin_check(user.id, user.username or "", profile.get("phone_number", "")):
        if update.effective_message:
            await update.effective_message.reply_text(
                "⛔ *ይቅርታ! ይህንን ማውጫ ለመጠቀም የአስተዳዳሪ (Admin) ፈቃድ የለዎትም።*",
                parse_mode="Markdown",
            )
        return

    # Gather system statistics
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) AS total FROM users WHERE role = 'player'")
        total_players = cursor.fetchone()["total"]

        cursor.execute("SELECT COUNT(*) AS verified FROM users WHERE role = 'player' AND is_verified = 1")
        verified_players = cursor.fetchone()["verified"]

        cursor.execute("SELECT SUM(balance) AS total_bal FROM users WHERE role = 'player'")
        bal_row = cursor.fetchone()
        total_balance = float(bal_row["total_bal"] or 0.0)

        cursor.execute("SELECT COUNT(*) AS pending FROM transactions WHERE status = 'pending'")
        pending_tx = cursor.fetchone()["pending"]

    admin_text = (
        f"🛡️ *Africa Bingo — Admin Control Center*\n\n"
        f"👤 *Super Admin:* @{user.username if user.username else user.id}\n\n"
        f"📊 *የስርዓት ሁኔታ (System Statistics):*\n"
        f"• *ተጫዋቾች (Total Players):* `{total_players}`\n"
        f"• *የተረጋገጡ (Verified Players):* `{verified_players}`\n"
        f"• *አጠቃላይ የተጫዋች ሂሳብ:* `{total_balance:.2f} ETB`\n"
        f"• *በመጠባበቅ ላይ ያሉ ጥያቄዎች:* `{pending_tx}`\n\n"
        f"ከታች ካሉት አማራጮች አንዱን ይምረጡ:"
    )

    keyboard = [
        [
            InlineKeyboardButton(text="👥 የተጫዋቾች ዝርዝር (Players)", callback_data="admin_players"),
            InlineKeyboardButton(text=f"💳 የግብይት ጥያቄዎች ({pending_tx})", callback_data="admin_pending_tx"),
        ],
        [
            InlineKeyboardButton(text="🌐 Admin Panel (Web Console)", web_app=WebAppInfo(url=get_game_web_url("admin.html", is_admin_user=True, user_id=user.id))),
        ],
        [
            InlineKeyboardButton(text="« ወደ ዋናው ማውጫ (Back)", callback_data="back_to_menu"),
        ],
    ]

    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.reply_text(
            text=admin_text,
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode="Markdown",
        )
    elif update.effective_message:
        await update.effective_message.reply_text(
            text=admin_text,
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode="Markdown",
        )

# ==============================================================================
# DEPOSIT & WITHDRAW FLOWS (Bound to Phone Number)
# ==============================================================================
async def deposit_flow(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Deposit prompt bound to verified phone number."""
    user = update.effective_user
    if not user:
        return
    profile = get_or_create_user(user.id, user.username or "", user.first_name or "", user.last_name or "")

    # Verification gate
    if not profile.get("is_verified") and not is_admin_check(user.id, user.username or ""):
        text = (
            "⚠️ *ገንዘብ ለማስገባት መጀመሪያ ስልክ ቁጥርዎን ማረጋገጥ አለብዎት።*\n\n"
            "እባክዎ ከታች ያለውን **'📱 ስልክ ቁጥርዎን ያጋሩ'** የሚለውን ቁልፍ በመጫን ያረጋግጡ።"
        )
        if update.callback_query:
            await update.callback_query.answer()
            await update.callback_query.message.reply_text(text=text, reply_markup=get_contact_request_keyboard(), parse_mode="Markdown")
        elif update.effective_message:
            await update.effective_message.reply_text(text=text, reply_markup=get_contact_request_keyboard(), parse_mode="Markdown")
        return

    text = "💳 የማስገቢያ መንገድ ይምረጡ"
    reply_markup = get_deposit_methods_keyboard()
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.reply_text(text=text, reply_markup=reply_markup)
    elif update.effective_message:
        await update.effective_message.reply_text(text=text, reply_markup=reply_markup)

async def withdraw_flow(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Withdrawal prompt bound to verified phone number."""
    user = update.effective_user
    if not user:
        return
    profile = get_or_create_user(user.id, user.username or "", user.first_name or "", user.last_name or "")

    # Verification gate
    if not profile.get("is_verified") and not is_admin_check(user.id, user.username or ""):
        text = (
            "⚠️ *ገንዘብ ለማውጣት መጀመሪያ ስልክ ቁጥርዎን ማረጋገጥ አለብዎት።*\n\n"
            "እባክዎ ከታች ያለውን **'📱 ስልክ ቁጥርዎን ያጋሩ'** የሚለውን ቁልፍ በመጫን ያረጋግጡ።"
        )
        if update.callback_query:
            await update.callback_query.answer()
            await update.callback_query.message.reply_text(text=text, reply_markup=get_contact_request_keyboard(), parse_mode="Markdown")
        elif update.effective_message:
            await update.effective_message.reply_text(text=text, reply_markup=get_contact_request_keyboard(), parse_mode="Markdown")
        return

    text = "🏧 የመውጫ መንገድ ይምረጡ"
    reply_markup = get_withdraw_methods_keyboard()
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.reply_text(text=text, reply_markup=reply_markup)
    elif update.effective_message:
        await update.effective_message.reply_text(text=text, reply_markup=reply_markup)

async def balance_flow(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Displays real-time balance pulled directly from SQLite DB."""
    user = update.effective_user
    if not user:
        return
    profile = get_or_create_user(user.id, user.username or "", user.first_name or "", user.last_name or "")

    balance = float(profile.get("balance", 0.0))
    bonus = float(profile.get("bonus_balance", 0.0))
    total = balance + bonus
    phone = profile.get("phone_number") or "ያልተረጋገጠ ⚠️"
    status_label = "የተረጋገጠ ✅" if profile.get("is_verified") else "ያልተረጋገጠ ⚠️"

    text = (
        f"💰 *የሂሳብ መረጃ (Account Balance)*\n\n"
        f"• *ዋና ሂሳብ (Main Balance):* `{balance:.2f} ETB`\n"
        f"• *ቦነስ ሂሳብ (Bonus Balance):* `{bonus:.2f} ETB`\n"
        f"• *አጠቃላይ (Total):* `{total:.2f} ETB`\n\n"
        f"• *የተረጋገጠ ስልክ:* `{phone}`\n"
        f"• *የተጫዋች ID:* `{user.id}`\n"
        f"• *የሂሳብ ሁኔታ:* {status_label}"
    )

    keyboard = [
        [
            InlineKeyboardButton(text="💳 አስገባ (Deposit)", callback_data="deposit"),
            InlineKeyboardButton(text="🏧 አውጣ (Withdraw)", callback_data="withdraw"),
        ],
        [
            InlineKeyboardButton(text="🎮 ጨዋታ ጀምር (Play Games)", web_app=WebAppInfo(url=get_game_web_url()))
        ],
        [
            InlineKeyboardButton(text="« ወደ ዋናው ማውጫ (Back)", callback_data="back_to_menu")
        ],
    ]

    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
    elif update.effective_message:
        await update.effective_message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def transactions_flow(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Displays transaction history pulled directly from SQLite DB."""
    user = update.effective_user
    if not user:
        return
    get_or_create_user(user.id, user.username or "", user.first_name or "", user.last_name or "")
    txs = get_user_transactions(user.id)

    lines = []
    if txs:
        for t in txs:
            kind = "🟢" if t.get("type") in ("deposit", "bonus", "win") else "🔴"
            amount = float(t.get("amount", 0.0))
            method = t.get("method", "TX")
            status = t.get("status", "completed")
            lines.append(f"{kind} *{method}*: `{amount:.2f} ETB` ({status})")
    else:
        lines.append("ምንም የተመዘገበ ግብይት የለም (No transactions found)")

    history_str = "\n".join(lines)
    text = (
        f"📜 *የቅርብ ጊዜ ግብይቶች (Transaction History)*\n\n"
        f"• *የተጫዋች ID:* `{user.id}`\n"
        f"• *የተመዘገቡ ግብይቶች ብዛት:* {len(txs)}\n\n"
        f"{history_str}\n\n"
        f"ሁሉንም ዝርዝር መረጃዎች በቀጥታ በጨዋታው ውስጥ መመልከት ይችላሉ።"
    )

    keyboard = [
        [
            InlineKeyboardButton(text="🎮 በጨዋታው ውስጥ ይመልከቱ (View in Game)", web_app=WebAppInfo(url=get_game_web_url()))
        ],
        [
            InlineKeyboardButton(text="« ወደ ዋናው ማውጫ (Back)", callback_data="back_to_menu")
        ],
    ]

    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
    elif update.effective_message:
        await update.effective_message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def transfer_flow(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handles transfer money flow."""
    text = (
        "↔️ *ገንዘብ ለጓደኛ ያስተላልፉ (Transfer Money)*\n\n"
        "ገንዘብን በቀጥታ ለሌላ ተጫዋች በ 0% የአገልግሎት ክፍያ ማስተላለፍ ይችላሉ።\n"
        "የተቀባዩን የተጠቃሚ ስም (Username) ወይም የተጫዋች ID በጨዋታው ውስጥ በማስገባት ወዲያውኑ ያስተላልፉ!"
    )
    keyboard = [
        [InlineKeyboardButton(text="🎮 በጨዋታው ውስጥ ያስተላልፉ", web_app=WebAppInfo(url=get_game_web_url()))],
        [InlineKeyboardButton(text="« ወደ ዋናው ማውጫ (Back)", callback_data="back_to_menu")],
    ]
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
    elif update.effective_message:
        await update.effective_message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def register_flow(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handles registration flow."""
    user = update.effective_user
    if not user:
        return
    profile = get_or_create_user(user.id, user.username or "", user.first_name or "", user.last_name or "")
    if not profile.get("is_verified"):
        await start_command(update, context)
        return

    name = user.first_name or "Player"
    text = (
        f"📝 *የተጠቃሚ መለያ (Account Profile)*\n\n"
        f"ሰላም, {name}!\n"
        f"የቴሌግራም መለያዎ (`{user.id}`) በስልክ ቁጥር `{profile.get('phone_number')}` ተረጋግጧል።\n\n"
        f"ጨዋታዎችን ለመጫወት ከታች ያለውን ቁልፍ ይጫኑ!"
    )
    keyboard = [
        [InlineKeyboardButton(text="🎮 Play Games (Start)", web_app=WebAppInfo(url=get_game_web_url()))],
        [InlineKeyboardButton(text="« ወደ ዋናው ማውጫ (Back)", callback_data="back_to_menu")],
    ]
    if update.effective_message:
        await update.effective_message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

# ==============================================================================
# CALLBACK QUERY ROUTER
# ==============================================================================
async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handles all inline button clicks."""
    query = update.callback_query
    if not query:
        return
    await query.answer()

    data = query.data
    user = update.effective_user
    if not user:
        return

    # Admin Control callbacks
    if data == "admin_dashboard":
        await admin_command(update, context)
        return

    if data == "admin_players":
        if not is_admin_check(user.id, user.username or ""):
            await query.message.reply_text("⛔ Access Denied.")
            return
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE role = 'player' ORDER BY registered_at DESC LIMIT 8")
            players = cursor.fetchall()
        
        lines = []
        for p in players:
            uname = f"@{p['username']}" if p["username"] else f"ID:{p['id']}"
            phone = p["phone_number"] or "No phone"
            bal = float(p["balance"] or 0.0)
            lines.append(f"• *{uname}* | `{phone}` | `{bal:.2f} ETB`")
        
        plist_str = "\n".join(lines) if lines else "ምንም የተመዘገቡ ተጫዋቾች የሉም።"
        text = f"👥 *የተጫዋቾች ዝርዝር (Registered Players):*\n\n{plist_str}"
        keyboard = [
            [InlineKeyboardButton(text="« ወደ Admin Controls", callback_data="admin_dashboard")]
        ]
        await query.message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
        return

    if data == "admin_pending_tx":
        if not is_admin_check(user.id, user.username or ""):
            await query.message.reply_text("⛔ Access Denied.")
            return
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM transactions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 8")
            txs = cursor.fetchall()
        
        if not txs:
            text = "✅ *በመጠባበቅ ላይ ያለ ምንም የግብይት ጥያቄ የለም።* (No pending transactions)"
            keyboard = [[InlineKeyboardButton(text="« ወደ Admin Controls", callback_data="admin_dashboard")]]
            await query.message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
            return

        text = "💳 *በመጠባበቅ ላይ ያሉ ግብይቶች (Pending Transactions):*\n\nየተጫዋቾችን ጥያቄ ለማጽደቅ ወይም ለመሰረዝ ከታች ያሉትን ቁልፎች ይጫኑ:"
        keyboard = []
        for t in txs:
            tx_id = t["id"]
            t_type = "ተቀማጭ (Deposit)" if t["type"] == "deposit" else "ማውጫ (Withdraw)"
            amt = float(t["amount"] or 0.0)
            u_id = t["user_id"]
            keyboard.append([
                InlineKeyboardButton(text=f"📋 {t_type} {amt:.0f} ETB (User {u_id})", callback_data="admin_pending_tx")
            ])
            keyboard.append([
                InlineKeyboardButton(text="✓ አጽድቅ (Approve)", callback_data=f"tx_app_{tx_id}"),
                InlineKeyboardButton(text="× ሰርዝ (Reject)", callback_data=f"tx_rej_{tx_id}"),
            ])

        keyboard.append([InlineKeyboardButton(text="« ወደ Admin Controls", callback_data="admin_dashboard")])
        await query.message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
        return

    if data.startswith("tx_app_"):
        if not is_admin_check(user.id, user.username or ""):
            await query.message.reply_text("⛔ Access Denied.")
            return
        tx_id = data.replace("tx_app_", "")
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM transactions WHERE id = ?", (tx_id,))
            tx = cursor.fetchone()
            if not tx or tx["status"] != "pending":
                await query.message.reply_text("⚠️ ይህ ግብይት ቀደም ሲል ተስተናግዷል።")
                return

            amount = float(tx["amount"] or 0.0)
            target_user_id = tx["user_id"]
            tx_type = tx["type"]

            if tx_type == "deposit":
                cursor.execute("UPDATE users SET balance = balance + ? WHERE id = ?", (amount, target_user_id))
            elif tx_type == "withdraw":
                cursor.execute("UPDATE users SET balance = MAX(0, balance - ?) WHERE id = ?", (amount, target_user_id))

            cursor.execute("UPDATE transactions SET status = 'approved' WHERE id = ?", (tx_id,))
            conn.commit()

        export_admin_players()

        # Notify target user
        try:
            if tx_type == "deposit":
                await context.bot.send_message(
                    chat_id=target_user_id,
                    text=f"🎉 *የተቀማጭ ጥያቄዎ ጸድቋል!*\n\n`{amount:.2f} ETB` ወደ ሂሳብዎ ተጨምሯል ✅\nአሁን በቀጥታ ጨዋታዎችን መጫወት ይችላሉ!",
                    parse_mode="Markdown",
                )
            else:
                await context.bot.send_message(
                    chat_id=target_user_id,
                    text=f"🏧 *የገንዘብ ማውጣት ጥያቄዎ ጸድቋል!*\n\nየ `{amount:.2f} ETB` ክፍያዎ በተመረጠው መንገድ ተልኳል ✅",
                    parse_mode="Markdown",
                )
        except Exception:
            pass

        action_word = "ተጨምሯል" if tx_type == "deposit" else "ተቀንሷል"
        await query.message.reply_text(
            f"✅ ግብይት `{tx_id}` ጸድቋል!\n`{amount:.2f} ETB` ወደ ተጠቃሚ `{target_user_id}` ሂሳብ {action_word}።",
            parse_mode="Markdown",
        )
        return

    if data.startswith("tx_rej_"):
        if not is_admin_check(user.id, user.username or ""):
            await query.message.reply_text("⛔ Access Denied.")
            return
        tx_id = data.replace("tx_rej_", "")
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM transactions WHERE id = ?", (tx_id,))
            tx = cursor.fetchone()
            if not tx or tx["status"] != "pending":
                await query.message.reply_text("⚠️ ይህ ግብይት ቀደም ሲል ተስተናግዷል።")
                return

            cursor.execute("UPDATE transactions SET status = 'rejected' WHERE id = ?", (tx_id,))
            conn.commit()

        export_admin_players()

        try:
            await context.bot.send_message(
                chat_id=tx["user_id"],
                text=f"⚠️ የ `{float(tx['amount']):.2f} ETB` {tx['type']} ጥያቄዎ ውድቅ ተደርጓል። እባክዎ መረጃዎን አስተካክለው እንደገና ይሞክሩ።",
                parse_mode="Markdown",
            )
        except Exception:
            pass

        await query.message.reply_text(f"× ግብይት `{tx_id}` ውድቅ ተደርጓል።", parse_mode="Markdown")
        return

    # Main options
    if data == "deposit":
        await deposit_flow(update, context)
        return
    if data == "withdraw":
        await withdraw_flow(update, context)
        return
    if data == "balance":
        await balance_flow(update, context)
        return
    if data == "transactions":
        await transactions_flow(update, context)
        return
    if data == "transfer":
        await transfer_flow(update, context)
        return
    if data == "back_to_menu":
        await start_command(update, context)
        return

    # Specific deposit method tapped (dep_Telebirr, dep_CBE Birr, dep_M-Pesa)
    if data.startswith("dep_"):
        method_name = data.replace("dep_", "")
        methods = get_payment_methods()
        method = methods.get(method_name, methods["Telebirr"])
        profile = get_or_create_user(user.id, user.username or "", user.first_name or "", user.last_name or "")
        phone = profile.get("phone_number") or "N/A"

        text = (
            f"💳 *{method['name']} የማስገቢያ መረጃ*\n\n"
            f"• *የሂሳብ ስም:* `{method['account_name']}`\n"
            f"• *የሂሳብ ቁጥር:* `{method['account_number']}` _(ለመገልበጥ ቁጥሩን ይንኩ)_\n"
            f"• *ዝቅተኛ መጠን:* `{method['min_amount']} ETB`\n"
            f"• *ቦነስ:* {method['bonus']} 🎁\n\n"
            f"📱 *የእርስዎ የተረጋገጠ ስልክ:* `{phone}`\n\n"
            f"ገንዘቡን ከላኩ በኋላ በጨዋታው ውስጥ የግብይት ቁጥርዎን (Tx Reference) በማስገባት በቀጥታ ማስገባት ይችላሉ።"
        )
        keyboard = [
            [InlineKeyboardButton(text="🎮 በጨዋታው ውስጥ አስገባ (Open Game)", web_app=WebAppInfo(url=get_game_web_url(extra_query="#deposit")))],
            [InlineKeyboardButton(text="« የማስገቢያ መንገዶች (Back)", callback_data="deposit")],
        ]
        await query.message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
        return

    # Specific withdraw method tapped (wth_Telebirr, wth_CBE Birr, wth_M-Pesa)
    if data.startswith("wth_"):
        method_name = data.replace("wth_", "")
        methods = get_payment_methods()
        method = methods.get(method_name, methods["Telebirr"])
        profile = get_or_create_user(user.id, user.username or "", user.first_name or "", user.last_name or "")
        phone = profile.get("phone_number") or "N/A"
        bal = float(profile.get("balance", 0.0))

        text = (
            f"🏧 *{method['name']} ገንዘብ ማውጫ*\n\n"
            f"• *የተመረጠ መንገድ:* {method['name']}\n"
            f"• *ገንዘቡ የሚላክበት ስልክ:* `{phone}`\n"
            f"• *የሚገኝ ሂሳብ:* `{bal:.2f} ETB`\n"
            f"• *ዝቅተኛ ማውጫ:* `{method['min_amount']} ETB`\n"
            f"• *የአገልግሎት ክፍያ:* `0% (ነፃ)`\n\n"
            f"ገንዘብ ለማውጣት በጨዋታው ውስጥ ማውጣት የሚፈልጉትን መጠን ያስገቡ። ገንዘቡ በቀጥታ ወደ `{phone}` ይላካል።"
        )
        keyboard = [
            [InlineKeyboardButton(text="🎮 በጨዋታው ውስጥ አውጣ (Withdraw in Game)", web_app=WebAppInfo(url=get_game_web_url(extra_query="#deposit")))],
            [InlineKeyboardButton(text="« የመውጫ መንገዶች (Back)", callback_data="withdraw")],
        ]
        await query.message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
        return

    # Profile option
    if data == "profile":
        profile = get_or_create_user(user.id, user.username or "", user.first_name or "", user.last_name or "")
        phone = profile.get("phone_number") or "ያልተረጋገጠ ⚠️"
        bal = float(profile.get("balance", 0.0))
        bonus_status = "የተወሰደ (10 ETB) ✅" if profile.get("bonus_claimed") else "ያልተወሰደ 🎁"
        is_admin = is_admin_check(user.id, user.username or "", phone)
        status_label = "Super Administrator 🛡️" if is_admin else ("የተረጋገጠ (Verified) ✅" if profile.get("is_verified") else "ያልተረጋገጠ ⚠️")

        fname = profile.get("first_name") or ""
        lname = profile.get("last_name") or ""
        full_name = f"{fname} {lname}".strip() or "Player"

        text = (
            f"👤 *የተጠቃሚ መረጃ (My Profile)*\n\n"
            f"• *ስም:* {full_name}\n"
            f"• *የቴሌግራም ID:* `{user.id}`\n"
            f"• *የተጠቃሚ ስም:* @{user.username if user.username else 'የለም'}\n"
            f"• *የተረጋገጠ ስልክ:* `{phone}`\n"
            f"• *ዋና ሂሳብ:* `{bal:.2f} ETB`\n"
            f"• *የቦነስ ሁኔታ:* {bonus_status}\n"
            f"• *የመለያ ሁኔታ:* {status_label}"
        )
        keyboard = [
            [InlineKeyboardButton(text="🎮 Play Games 🎮", web_app=WebAppInfo(url=get_game_web_url()))],
            [InlineKeyboardButton(text="« ወደ ዋናው ማውጫ (Back)", callback_data="back_to_menu")],
        ]
        await query.message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
        return

    # Refer & Earn
    if data == "refer_earn":
        bot_username = (await context.bot.get_me()).username
        text = (
            f"🎁 *የሪፈራል ፕሮግራም (Refer & Earn)*\n\n"
            f"ጓደኞችዎን ይጋብዙ እና በእያንዳንዱ በሚጫወቱት ጨዋታ የኮሚሽን ቦነስ ያግኙ!\n\n"
            f"🔗 *የእርስዎ የግብዣ ሊንክ (Referral Link):*\n"
            f"`https://t.me/{bot_username}?start=ref_{user.id}`"
        )
        keyboard = [
            [InlineKeyboardButton(text="« ወደ ዋናው ማውጫ (Back)", callback_data="back_to_menu")]
        ]
        await query.message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
        return

    # Contact Us
    if data == "contact_us":
        text = (
            "📞 *የደንበኞች አገልግሎት (Contact Us)*\n\n"
            "ማንኛውም ጥያቄ ወይም ድጋፍ ከፈለጉ የ 24/7 የደንበኞች አገልግሎታችንን ያነጋግሩ።"
        )
        keyboard = [
            [InlineKeyboardButton(text="« ወደ ዋናው ማውጫ (Back)", callback_data="back_to_menu")]
        ]
        await query.message.reply_text(text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
        return

# ==============================================================================
# MENU SETUP (post_init)
# ==============================================================================
async def post_init(application: Application) -> None:
    """Sets the Telegram bot menu commands and menu button matching reference UI."""
    try:
        await application.bot.delete_webhook(drop_pending_updates=True)
        logger.info("Deleted any existing webhook to ensure clean polling.")
    except Exception as e:
        logger.warning("Could not delete webhook: %s", e)

    commands = [
        BotCommand("start", "ቦቱን ያስጀምሩ / ዋና ማውጫ"),
        BotCommand("deposit", "ገንዘብ ገቢ ለማድረግ"),
        BotCommand("withdraw", "ገንዘብ ወጪ ለማድረግ"),
        BotCommand("balance", "የሂሳብ መጠን ለማየት"),
        BotCommand("register", "አዲስ አካውንት ለመመዝገብ"),
        BotCommand("transfer", "ገንዘብ ለሌላ ተጫዋች ለማስተላለፍ"),
        BotCommand("help", "እርዳታ እና ድጋፍ ለማግኘት"),
    ]
    desc_text = (
        "ይህ ቦት እየተዝናኑ ተጨማሪ ገቢ የሚያገኙበት መድረክ ነው።\n\n"
        "✅ ፈጣንና ደህንነቱ የተጠበቀ ገቢ እና ወጪ\n"
        "🎁 ገቢ ሲያደርጉ 10% ተጨማሪ ስጦታ\n"
        "💎 በየ እለቱ የጠዋት እና የማታ ሻሞዎች እና ስጦታዎች\n"
        "🎁 አዲስ ተመዝጋቢዎች የመጀመሪያ 10 ETB ስጦታ\n"
        "✅ ብዙ ተጫዋቾች ላጋበዙ እና ብዙ ጨዋታዎችን ለተጫወቱ በየሳምንቱ ደስ የሚል ሽልማት\n"
        "👉 በአጭር ጊዜ ውስጥ በሁሉም ተጫዋቾች ተወዳጅነትን ያተረፈው አፍሪካ ቢንጎ\n\n"
        "/start በመጫን መጀመር ይችላሉ!"
    )
    short_desc_text = "ይህ ቦት እየተዝናኑ ተጨማሪ ገቢ የሚያገኙበት መድረክ ነው። /start በመጫን ይጀምሩ!"

    try:
        await application.bot.set_my_description(description=desc_text)
        await application.bot.set_my_short_description(short_description=short_desc_text)
        logger.info("Bot description and short description updated successfully.")
    except Exception as e:
        logger.warning("Could not set bot description: %s", e)

    try:
        await application.bot.set_my_commands(commands)
        try:
            await application.bot.set_chat_menu_button(
                menu_button=MenuButtonWebApp(text="🎮 ቢንጎ ተጫወት", web_app=WebAppInfo(url=get_game_web_url()))
            )
        except Exception:
            await application.bot.set_chat_menu_button(menu_button=MenuButtonCommands())
        logger.info("Bot commands menu and Play Games WebApp button registered successfully.")
    except Exception as e:
        logger.warning("Could not set bot commands or menu button immediately: %s", e)

# ==============================================================================
# BACKGROUND WEB / HEALTH SERVER (FOR ETHIODEPLOY / CLOUD HOSTING)
# ==============================================================================
def get_admin_overview() -> Dict[str, Any]:
    """Returns complete admin state from SQLite and GameEngine."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        
        # 1. Rooms
        rooms = []
        for rid in ['10', '20', '50']:
            rstate = game_engine.get_room_state(rid)
            if rstate:
                cursor.execute('SELECT enabled FROM game_rooms WHERE id = ?', (rid,))
                row = cursor.fetchone()
                rstate['enabled'] = bool(row['enabled']) if (row and 'enabled' in row.keys() and row['enabled'] is not None) else True
                rooms.append(rstate)
                
        # 2. Users / Players
        cursor.execute('''
            SELECT id, username, first_name, last_name, phone_number, role, balance, bonus_balance, is_verified, status, registered_at, last_active 
            FROM users ORDER BY registered_at DESC LIMIT 100
        ''')
        users_list = [dict(r) for r in cursor.fetchall()]
        
        # 3. Transactions
        cursor.execute('''
            SELECT t.id, t.user_id, t.type, t.method, t.amount, t.phone_number, t.status, t.created_at, u.username, u.first_name
            FROM transactions t
            LEFT JOIN users u ON t.user_id = u.id
            ORDER BY t.created_at DESC LIMIT 50
        ''')
        txs_list = [dict(r) for r in cursor.fetchall()]
        
        # 4. Metrics
        cursor.execute('SELECT COUNT(*) as total_users FROM users')
        tot_users = cursor.fetchone()['total_users']
        cursor.execute('SELECT COUNT(*) as ver_users FROM users WHERE is_verified = 1')
        ver_users = cursor.fetchone()['ver_users']
        cursor.execute('SELECT COUNT(*) as pending_tx FROM transactions WHERE status = "pending"')
        pend_tx = cursor.fetchone()['pending_tx']
        cursor.execute('SELECT COALESCE(SUM(amount), 0) as tot_dep FROM transactions WHERE type = "deposit" AND status IN ("completed", "approved")')
        tot_dep = cursor.fetchone()['tot_dep']
        cursor.execute('SELECT COALESCE(SUM(amount), 0) as tot_wth FROM transactions WHERE type = "withdraw" AND status IN ("completed", "approved")')
        tot_wth = cursor.fetchone()['tot_wth']
        
        total_live_players = sum(r.get('player_count', 0) for r in rooms)
        
        return {
            'rooms': rooms,
            'players': users_list,
            'transactions': txs_list,
            'metrics': {
                'totalPlayers': tot_users,
                'verifiedPlayers': ver_users,
                'activePlayers': total_live_players,
                'pendingTransactions': pend_tx,
                'totalDeposits': tot_dep,
                'totalWithdrawals': tot_wth,
                'processedToday': tot_dep + tot_wth,
            },
            'settings': get_all_game_settings()
        }

def update_admin_transaction(tx_id: str, action: str) -> Dict[str, Any]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM transactions WHERE id = ?', (tx_id,))
        tx = cursor.fetchone()
        if not tx:
            return {'error': 'Transaction not found'}
        if tx['status'] != 'pending':
            return {'error': f"Transaction already {tx['status']}"}
        
        user_id = tx['user_id']
        amount = float(tx['amount'])
        tx_type = tx['type']
        
        if action == 'approve':
            if tx_type == 'deposit':
                cursor.execute('UPDATE users SET balance = balance + ? WHERE id = ?', (amount, user_id))
            cursor.execute('UPDATE transactions SET status = ? WHERE id = ?', ('approved', tx_id))
            conn.commit()
            export_admin_players()
            return {'ok': True, 'status': 'approved', 'id': tx_id}
        elif action == 'reject':
            if tx_type == 'withdraw':
                cursor.execute('UPDATE users SET balance = balance + ? WHERE id = ?', (amount, user_id))
            cursor.execute('UPDATE transactions SET status = ? WHERE id = ?', ('rejected', tx_id))
            conn.commit()
            export_admin_players()
            return {'ok': True, 'status': 'rejected', 'id': tx_id}
        else:
            return {'error': 'Invalid action'}

def update_admin_user(user_id: int, updates: Dict[str, Any]) -> Dict[str, Any]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT id, balance FROM users WHERE id = ?', (user_id,))
        u = cursor.fetchone()
        if not u:
            return {'error': 'User not found'}
        if 'balance' in updates:
            new_bal = float(updates['balance'])
            cursor.execute('UPDATE users SET balance = ? WHERE id = ?', (new_bal, user_id))
        if 'is_verified' in updates:
            cursor.execute('UPDATE users SET is_verified = ? WHERE id = ?', (int(bool(updates['is_verified'])), user_id))
        if 'status' in updates:
            cursor.execute('UPDATE users SET status = ? WHERE id = ?', (str(updates['status']), user_id))
        conn.commit()
        export_admin_players()
        return {'ok': True, 'user_id': user_id}

def start_background_web_server() -> None:
    """Runs background HTTP server(s) to respond to API requests, health checks, and serve the webapp."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    primary_port = int(os.getenv("PORT", "3000"))
    ports = [primary_port]
    for p in (3000, 8080):
        if p not in ports:
            ports.append(p)

    class APIServer(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=base_dir, **kwargs)
            
        def send_cors_headers(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE, HEAD')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data, X-Telegram-User-Id, X-Telegram-User-Name, X-Admin-Token, X-Admin-Password, Authorization')
            
        def do_OPTIONS(self):
            self.send_response(200)
            self.send_cors_headers()
            self.end_headers()

        def do_HEAD(self):
            if self.path in ("/health", "/healthz", "/ping", "/api/health"):
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_cors_headers()
                self.end_headers()
                return
            if self.path == "/" or not self.path:
                self.path = "/index.html"
            return super().do_HEAD()
            
        def is_admin_request(self) -> bool:
            user = self.get_user_from_headers()
            if user and is_admin_check(user.get('id', 0), user.get('username', '')):
                return True
            token = self.headers.get('X-Admin-Token', '')
            admin_pwd = self.headers.get('X-Admin-Password', '')
            auth_header = self.headers.get('Authorization', '')
            if auth_header.startswith('Bearer '):
                token = auth_header.split(' ', 1)[1].strip()
            valid_admin_identifiers = [adm.lower() for adm in ADMIN_USERNAMES + ADMIN_PHONES] + ["0999909474", "+251999909474", "su121316", "samtesfa19"]
            valid_tokens = [hashlib.sha256(f"{u}:{ADMIN_PASSWORD}".encode()).hexdigest() for u in valid_admin_identifiers]
            if token in valid_tokens or admin_pwd == ADMIN_PASSWORD:
                return True
            return False

        def get_user_from_headers(self):
            init_data = self.headers.get('X-Telegram-Init-Data', '')
            if init_data:
                user = validate_telegram_webapp(init_data)
                if user:
                    return user

            user_id_str = self.headers.get('X-Telegram-User-Id')
            username = self.headers.get('X-Telegram-User-Name', '')
            if user_id_str and user_id_str.isdigit():
                uid = int(user_id_str)
                u = get_user_by_id(uid)
                if not u:
                    u = get_or_create_user(
                        user_id=uid,
                        username=username or f"player_{str(uid)[-4:]}",
                        first_name="Africa Player"
                    )
                if not u.get('is_verified'):
                    with get_db_connection() as conn:
                        cursor = conn.cursor()
                        cursor.execute("UPDATE users SET is_verified = 1 WHERE id = ?", (uid,))
                        conn.commit()
                    u = get_user_by_id(uid)
                return u
            return None
            
        def send_json(self, data, status=200):
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps(data).encode('utf-8'))
            
        def do_GET(self):
            if self.path in ("/health", "/healthz", "/ping", "/api/health"):
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_cors_headers()
                self.end_headers()
                self.wfile.write(b"OK")
                return
                
            if self.path.startswith('/api/'):
                parsed_path = urllib.parse.urlparse(self.path)
                path = parsed_path.path
                query = dict(urllib.parse.parse_qsl(parsed_path.query))
                
                # 1. Public lobby rooms & room state (accessible to all devices)
                if path == '/api/rooms':
                    rooms_info = []
                    for rid in ['10', '20', '50']:
                        state = game_engine.get_room_state(rid)
                        if state:
                            result = game_engine.get_round_result(rid)
                            if result:
                                state['last_result'] = result
                            rooms_info.append(state)
                    return self.send_json({
                        'rooms': rooms_info,
                        'settings': get_all_game_settings()
                    })
                    
                elif path == '/api/room-state':
                    room_id = query.get('room_id')
                    if not room_id:
                        return self.send_json({'error': 'Missing room_id'}, status=400)
                    state = game_engine.get_room_state(room_id)
                    if not state:
                        return self.send_json({'error': 'Room not found'}, status=404)
                    result = game_engine.get_round_result(room_id)
                    if result:
                        state['last_result'] = result
                    return self.send_json(state)

                # 2. Admin overview (all rooms, active players, real users, transactions, metrics, settings)
                elif path == '/api/admin/overview':
                    if not self.is_admin_request():
                        return self.send_json({'error': 'Unauthorized'}, status=401)
                    return self.send_json(get_admin_overview())

                # 2b. Public/Admin settings endpoint
                elif path == '/api/settings':
                    return self.send_json(get_all_game_settings())
                
                # 3. User profile endpoint
                elif path == '/api/me':
                    user = self.get_user_from_headers()
                    if not user:
                        return self.send_json({'error': 'Unauthorized'}, status=401)
                    db_user = get_or_create_user(
                        user_id=user.get('id', 0),
                        username=user.get('username', ''),
                        first_name=user.get('first_name', ''),
                        last_name=user.get('last_name', '')
                    )
                    with get_db_connection() as conn:
                        cursor = conn.cursor()
                        cursor.execute(
                            '''SELECT rp.room_id, rp.round_id, rp.card_ids, gr.status,
                                      gr.countdown_ends_at, gr.round_id AS current_round_id
                               FROM room_players rp
                               JOIN game_rooms gr ON gr.id = rp.room_id
                               WHERE rp.user_id = ? AND rp.round_id = gr.round_id
                                 AND gr.status IN ('open', 'countdown', 'live')
                               ORDER BY rp.joined_at DESC LIMIT 1''',
                            (user.get('id', 0),),
                        )
                        active = cursor.fetchone()
                        cursor.execute(
                            '''SELECT id, user_id, type, method, amount, phone_number, status, created_at
                               FROM transactions
                               WHERE user_id = ?
                               ORDER BY created_at DESC LIMIT 30''',
                            (user.get('id', 0),)
                        )
                        txs = [dict(r) for r in cursor.fetchall()]
                    response = dict(db_user)
                    response['transactions'] = txs
                    response['active_room'] = dict(active) if active else None
                    if response['active_room']:
                        try:
                            response['active_room']['card_ids'] = json.loads(response['active_room'].get('card_ids') or '[]')
                        except (TypeError, ValueError):
                            response['active_room']['card_ids'] = []
                    return self.send_json(response)
                    
                # 4. Health check endpoint
                elif path in ('/api/health', '/health'):
                    return self.send_json({'ok': True, 'status': 'healthy'})
                    
                else:
                    return self.send_json({'error': 'Not found'}, status=404)
                    
            if self.path == "/" or not self.path:
                self.path = "/index.html"
            return super().do_GET()
            
        def do_POST(self):
            parsed_path = urllib.parse.urlparse(self.path).path
            body = {}
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length > 0:
                try:
                    body = json.loads(self.rfile.read(content_length))
                except Exception:
                    return self.send_json({'error': 'Invalid JSON'}, status=400)

            # 1. Admin login
            if parsed_path == '/api/admin/login':
                u = str(body.get('username', '')).strip().lstrip('@').lower()
                p = str(body.get('password', '')).strip()
                valid_admin_identifiers = [adm.lower() for adm in ADMIN_USERNAMES + ADMIN_PHONES] + ["0999909474", "+251999909474", "999909474"]
                if u in valid_admin_identifiers and p == ADMIN_PASSWORD:
                    token = hashlib.sha256(f"{u}:{ADMIN_PASSWORD}".encode()).hexdigest()
                    return self.send_json({'ok': True, 'username': u, 'token': token, 'role': 'admin'})
                return self.send_json({'error': 'Invalid credentials'}, status=401)

            # 2. Admin room control
            if parsed_path == '/api/admin/room/update':
                if not self.is_admin_request():
                    return self.send_json({'error': 'Unauthorized'}, status=401)
                room_id = str(body.get('room_id', ''))
                action = str(body.get('action', ''))
                if not room_id:
                    return self.send_json({'error': 'Missing room_id'}, status=400)
                if action == 'pause':
                    res = game_engine.admin_pause_room(room_id, paused=True)
                elif action == 'resume':
                    res = game_engine.admin_pause_room(room_id, paused=False)
                elif action == 'reset':
                    res = game_engine.admin_reset_room(room_id)
                elif action == 'force_countdown':
                    secs = int(body.get('countdown_secs', 60))
                    res = game_engine.admin_force_countdown(room_id, countdown_secs=secs)
                elif action == 'toggle_enabled':
                    res = game_engine.admin_toggle_room_enabled(room_id)
                else:
                    return self.send_json({'error': f'Unknown action: {action}'}, status=400)
                return self.send_json(res)

            # 3. Admin transaction control
            if parsed_path == '/api/admin/transaction/update':
                if not self.is_admin_request():
                    return self.send_json({'error': 'Unauthorized'}, status=401)
                tx_id = str(body.get('id', ''))
                action = str(body.get('action', ''))
                if not tx_id or not action:
                    return self.send_json({'error': 'Missing id or action'}, status=400)
                res = update_admin_transaction(tx_id, action)
                return self.send_json(res, status=200 if res.get('ok') else 400)

            # 4. Admin user control
            if parsed_path == '/api/admin/user/update':
                if not self.is_admin_request():
                    return self.send_json({'error': 'Unauthorized'}, status=401)
                user_id = int(body.get('user_id', 0))
                if not user_id:
                    return self.send_json({'error': 'Missing user_id'}, status=400)
                res = update_admin_user(user_id, body)
                return self.send_json(res)

            # 4b. Admin settings control
            if parsed_path == '/api/admin/settings/update':
                if not self.is_admin_request():
                    return self.send_json({'error': 'Unauthorized'}, status=401)
                for k, v in body.items():
                    set_game_setting(k, v)

                # If admin is enabling/setting a bonus amount, grant it to all users
                bonus_amount = body.get('startingBonus') or body.get('starting_bonus')
                bonus_enabled = body.get('startingBonusEnabled', body.get('starting_bonus_enabled'))
                if bonus_amount is not None and bonus_enabled:
                    try:
                        bonus_val = float(bonus_amount)
                        if bonus_val > 0:
                            now_ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
                            with get_db_connection() as bconn:
                                bc = bconn.cursor()
                                bc.execute("SELECT id FROM users WHERE role != 'admin' AND bonus_claimed = 0")
                                eligible = bc.fetchall()
                                for row in eligible:
                                    uid = row['id']
                                    bc.execute("UPDATE users SET balance = balance + ?, bonus_claimed = 1 WHERE id = ?", (bonus_val, uid))
                                    tx_id = f"TX-BN-{uid}-{int(datetime.utcnow().timestamp())}"
                                    bc.execute("""
                                        INSERT OR IGNORE INTO transactions (id, user_id, type, method, amount, status, created_at)
                                        VALUES (?, ?, 'bonus', 'Admin Bonus', ?, 'completed', ?)
                                    """, (tx_id, uid, bonus_val, now_ts))
                                bconn.commit()
                    except Exception as e:
                        logger.warning(f"Bonus grant error: {e}")

                return self.send_json({'ok': True, 'settings': get_all_game_settings()})


            # 5. Player authenticated endpoints
            if self.path.startswith('/api/'):
                user = self.get_user_from_headers()
                if not user:
                    return self.send_json({'error': 'Unauthorized'}, status=401)

                if parsed_path in ('/api/join-room', '/api/room/join'):
                    room_id = body.get('room_id')
                    card_ids = body.get('card_ids', [])
                    if not room_id or not isinstance(card_ids, list):
                        return self.send_json({'error': 'Invalid request'}, status=400)

                    db_user = get_or_create_user(
                        user_id=user.get('id', 0),
                        username=user.get('username', ''),
                        first_name=user.get('first_name', ''),
                        last_name=user.get('last_name', ''),
                    )
                    if not db_user.get('is_verified') and not is_admin_check(
                        user.get('id', 0), user.get('username', ''), db_user.get('phone_number', '')
                    ):
                        return self.send_json({
                            'error': 'Share your Telegram contact before playing',
                            'requires_contact': True,
                        }, status=403)

                    result = game_engine.join_room(str(room_id), user.get('id', 0), card_ids)
                    return self.send_json(result, status=200 if result.get('ok') else 400)
                    
                elif parsed_path == '/api/leave-room':
                    room_id = body.get('room_id')
                    if not room_id:
                        return self.send_json({'error': 'Invalid request'}, status=400)
                    result = game_engine.leave_room(str(room_id), user.get('id', 0))
                    return self.send_json(result)
                    
                elif parsed_path == '/api/claim-bingo':
                    room_id = body.get('room_id')
                    card_id = body.get('card_id')
                    if not room_id or not card_id:
                        return self.send_json({'error': 'Invalid request'}, status=400)
                    result = game_engine.claim_bingo(str(room_id), user.get('id', 0), card_id)
                    return self.send_json(result)

                elif parsed_path == '/api/deposit':
                    amount = float(body.get('amount', 0))
                    method = str(body.get('method', 'Telebirr'))
                    reference = str(body.get('reference', ''))
                    phone = str(body.get('phone', ''))
                    if amount < 50:
                        return self.send_json({'error': 'Minimum deposit is 50 ETB'}, status=400)
                    tx_id = f"DEP-{int(time.time())}-{random.randint(1000, 9999)}"
                    now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
                    with get_db_connection() as conn:
                        cursor = conn.cursor()
                        cursor.execute(
                            "INSERT INTO transactions (id, user_id, type, method, amount, phone_number, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            (tx_id, user.get('id', 0), 'deposit', method, amount, phone or reference, 'pending', now)
                        )
                        conn.commit()
                    export_admin_players()
                    threading.Thread(
                        target=notify_admins_transaction,
                        args=(tx_id, 'deposit', amount, method, user, phone or reference),
                        daemon=True
                    ).start()
                    return self.send_json({'ok': True, 'id': tx_id})

                elif parsed_path == '/api/withdraw':
                    amount = float(body.get('amount', 0))
                    method = str(body.get('method', 'Telebirr'))
                    phone = str(body.get('phone', ''))
                    if amount < 50:
                        return self.send_json({'error': 'Minimum withdrawal is 50 ETB'}, status=400)
                    uid = user.get('id', 0)
                    with get_db_connection() as conn:
                        cursor = conn.cursor()
                        cursor.execute("SELECT balance FROM users WHERE id = ?", (uid,))
                        u = cursor.fetchone()
                        if not u or float(u['balance'] or 0.0) < amount:
                            return self.send_json({'error': 'Insufficient balance'}, status=400)
                        cursor.execute("UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?", (amount, uid, amount))
                        if cursor.rowcount == 0:
                            return self.send_json({'error': 'Insufficient balance'}, status=400)
                        tx_id = f"WTH-{int(time.time())}-{random.randint(1000, 9999)}"
                        now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
                        cursor.execute(
                            "INSERT INTO transactions (id, user_id, type, method, amount, phone_number, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            (tx_id, uid, 'withdraw', method, amount, phone, 'pending', now)
                        )
                        conn.commit()
                    export_admin_players()
                    threading.Thread(
                        target=notify_admins_transaction,
                        args=(tx_id, 'withdraw', amount, method, user, phone),
                        daemon=True
                    ).start()
                    return self.send_json({'ok': True, 'id': tx_id})

                else:
                    return self.send_json({'error': 'Not found'}, status=404)

        def log_message(self, format, *args):
            pass

    for p in ports:
        def make_serve(port_num):
            def serve():
                try:
                    server = HTTPServer(("0.0.0.0", port_num), APIServer)
                    logger.info("Background HTTP/API server listening on port %d", port_num)
                    server.serve_forever()
                except Exception as e:
                    logger.warning("Port %d bind skipped or failed: %s", port_num, e)
            return serve

        t = threading.Thread(target=make_serve(p), daemon=True)
        t.start()

# ==============================================================================
# MAIN APPLICATION
# ==============================================================================
def main() -> None:
    """Starts the bot."""
    init_db()
    export_admin_players()
    start_background_web_server()

    if BOT_TOKEN == "YOUR_BOT_TOKEN_HERE":
        logger.warning(
            "[WARNING] BOT_TOKEN is not set! Please edit BOT_TOKEN in bot.py or set the BOT_TOKEN environment variable."
        )

    app = (
        Application.builder()
        .token(BOT_TOKEN)
        .read_timeout(30)
        .write_timeout(30)
        .connect_timeout(30)
        .post_init(post_init)
        .build()
    )

    # Command handlers matching the menu
    app.add_handler(CommandHandler(["start", "Start", "help", "menu"], start_command))
    app.add_handler(CommandHandler(["deposit", "Deposit"], deposit_flow))
    app.add_handler(CommandHandler(["withdraw", "Withdraw"], withdraw_flow))
    app.add_handler(CommandHandler(["balance", "Balance"], balance_flow))
    app.add_handler(CommandHandler(["transactions", "Transactions", "transaction", "Transaction"], transactions_flow))
    app.add_handler(CommandHandler(["register", "Register"], register_flow))
    app.add_handler(CommandHandler(["transfer", "Transfer"], transfer_flow))
    app.add_handler(CommandHandler(["admin", "Admin"], admin_command))

    # Contact handler for phone number sharing & anti-fraud bonus verification
    app.add_handler(MessageHandler(filters.CONTACT, contact_handler))

    # Text handler for persistent reply keyboard buttons
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, menu_text_handler))

    # Inline button callback router
    app.add_handler(CallbackQueryHandler(button_callback))

    async def global_error_handler(update, context):
        err_name = type(context.error).__name__
        if "Conflict" in err_name:
            logger.info("Telegram polling conflict: Another bot poller is active. Background API server and game engine remain 100% active.")
            return
        logger.error("Exception while handling an update:", exc_info=context.error)

    app.add_error_handler(global_error_handler)

    print("[INFO] Africa Bingo Bot is starting... Polling for updates.")
    try:
        app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)
    except Exception as e:
        logger.warning("Telegram polling finished or running elsewhere: %s", e)
    
    # Always keep background web server and game engine alive
    print("[INFO] Authoritative multi-device game engine & API server are running.")
    try:
        while True:
            time.sleep(3600)
    except (KeyboardInterrupt, SystemExit):
        pass

if __name__ == "__main__":
    main()
