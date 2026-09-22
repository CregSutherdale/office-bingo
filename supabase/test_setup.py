"""Runs migrations/20260922000000_bingo.sql against a real throwaway Postgres (pip install pgserver psycopg2-binary)
and checks every function the way the app calls it, as Supabase's `anon` role.

    python supabase/test_setup.py      -> prints SETUP_SQL_OK or raises
"""
import json
import os
import shutil
import sys
import tempfile

import pgserver
import psycopg2

HERE = os.path.dirname(os.path.abspath(__file__))
CODE = "CHANGE-ME"
WEEK = "2026-09-21"
NEXT = "2026-09-28"


def main():
    data = tempfile.mkdtemp(prefix="bingo_pg_")
    srv = pgserver.get_server(data, cleanup_mode="stop")
    try:
        conn = psycopg2.connect(srv.get_uri())
        conn.autocommit = True
        cur = conn.cursor()
        # the two roles every Supabase project has
        cur.execute("do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;")
        cur.execute("do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;")
        cur.execute("grant usage on schema public to anon, authenticated;")
        sql = open(os.path.join(HERE, "migrations", "20260922000000_bingo.sql"), encoding="utf-8").read()
        cur.execute(sql)
        cur.execute(sql)  # running it twice must be safe

        def call(fn, *args):
            cur.execute("set role anon;")
            try:
                cur.execute("select %s(%s)" % (fn, ",".join(["%s"] * len(args))), args)
                return cur.fetchone()[0]
            finally:
                cur.execute("reset role;")

        # the tables are closed to the app role
        cur.execute("set role anon;")
        for t in ("bingo_secret", "bingo_settings", "bingo_weeks", "bingo_marks"):
            try:
                cur.execute("select * from %s" % t)
                raise AssertionError("anon read %s directly" % t)
            except psycopg2.Error:
                pass
        cur.execute("reset role;")

        # wrong code is refused
        try:
            call("bingo_state", "nope", WEEK)
            raise AssertionError("wrong team code accepted")
        except psycopg2.Error as e:
            assert "bad team code" in str(e), e
        cur.execute("reset role;")

        st = call("bingo_state", CODE, WEEK)
        assert st["week"]["layout"][12] == "FREE" and st["week"]["layout"][11] == "Added Auto", st["week"]
        assert [m["cell"] for m in st["marks"]] == [11, 17, 20, 23], st["marks"]
        items = st["settings"]["items"]
        assert sum(i["count"] for i in items) == 24, items
        assert any(i["label"] == "RDP" for i in items)

        # mark / double mark keeps the first X / unmark
        st = call("bingo_mark", CODE, WEEK, 0, "Kyle")
        st = call("bingo_mark", CODE, WEEK, 0, "Someone else")
        m0 = [m for m in st["marks"] if m["cell"] == 0][0]
        assert m0["by"] == "Kyle", m0
        st = call("bingo_unmark", CODE, WEEK, 0)
        assert 0 not in [m["cell"] for m in st["marks"]]
        try:
            call("bingo_mark", CODE, WEEK, 12, "Kyle")   # FREE can't be marked
            raise AssertionError("free square marked")
        except psycopg2.Error:
            cur.execute("reset role;")

        # new week: the first phone's shuffle wins, the second gets the same card
        a = ["A%d" % i for i in range(25)]; a[12] = "FREE"
        b = ["B%d" % i for i in range(25)]; b[12] = "FREE"
        st = call("bingo_ensure_week", CODE, NEXT, json.dumps(a))
        st2 = call("bingo_ensure_week", CODE, NEXT, json.dumps(b))
        assert st2["week"]["layout"][0] == "A0", st2["week"]
        assert st2["weeks"][:2] == [NEXT, WEEK], st2["weeks"]

        # reshuffle clears the X's
        call("bingo_mark", CODE, NEXT, 3, "Kyle")
        st = call("bingo_set_layout", CODE, NEXT, json.dumps(b))
        assert st["week"]["layout"][0] == "B0" and st["marks"] == [], st
        try:
            call("bingo_set_layout", CODE, NEXT, json.dumps(["x"] * 3))
            raise AssertionError("short layout accepted")
        except psycopg2.Error:
            cur.execute("reset role;")

        # settings round-trip
        s = dict(st["settings"]); s["team"] = ["Kyle", "Dana"]
        st = call("bingo_save_settings", CODE, NEXT, json.dumps(s))
        assert st["settings"]["team"] == ["Kyle", "Dana"]

        # the old week is untouched
        st = call("bingo_state", CODE, WEEK)
        assert [m["cell"] for m in st["marks"]] == [11, 17, 20, 23]
        conn.close()
        print("SETUP_SQL_OK functions=7 checks=13")
    finally:
        try:
            srv.cleanup()
        except Exception:
            pass
        shutil.rmtree(data, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
