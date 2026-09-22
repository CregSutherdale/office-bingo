// Supabase project for the shared card. Both values are safe to publish: the anon key only
// reaches the bingo_* functions, and every one of them checks the team code (which is NOT here;
// it travels in the invite link). Leave empty for demo mode (this phone only).
window.BINGO_CONFIG = {
  url: "",
  anonKey: ""
};
