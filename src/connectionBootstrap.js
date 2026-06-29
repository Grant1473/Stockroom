"use strict";

// Initialize the connection when the app loads
(async () => {
  try {
    console.log('[App] Initializing Supabase connection manager...');
    if (typeof window !== 'undefined' && window.SupabaseConnection) {
      await window.SupabaseConnection.initialize();
      console.log('[App] Supabase connection initialized');
      
      if (window.SupabaseConnection.isReady()) {
        console.log('[App] Supabase connection ready for operations');
      } else {
        console.warn('[App] Supabase connection not ready');
      }
    } else {
      console.error('[App] SupabaseConnectionManager not available');
    }
  } catch (error) {
    console.error('[App] Failed to initialize connection:', error);
  }
})();
