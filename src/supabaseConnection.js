"use strict";

/**
 * Supabase Connection Manager
 * 
 * Dedicated connection handler with retry logic and auto-reconnection
 * for robust operations in the Inventory application
 */

class SupabaseConnectionManager {
  constructor() {
    this.maxInitialRetries = 3;
    this.maxReconnectAttempts = 5;
    this.retryDelay = 2000;
    this.reconnectInterval = 30000;
    this.isInitialized = false;
    this.isConnecting = false;
    this.connectionAttempts = 0;
    this.reconnectTimer = null;
    this.config = {
      url: '',
      key: '',
      autoReconnect: true,
      retryAttempts: 3
    };
    this.subscribers = [];
    this.connectionState = 'disconnected';
  }

  async initialize() {
    if (this.isInitialized) return Promise.resolve();
    
    try {
      await this.loadConfiguration();
      await this.attemptInitialConnection();
      this.startAutoReconnection();
      this.isInitialized = true;
      return true;
    } catch (error) {
      console.error('[SupabaseConnection] Initialization failed:', error);
      return false;
    }
  }

  async loadConfiguration() {
    try {
      const response = await fetch('/api/supabase-config');
      const data = await response.json();
      this.config = {
        ...this.config,
        url: data.url || this.config.url,
        key: data.key || this.config.key
      };
      console.log('[SupabaseConnection] Configuration loaded:', {
        url: this.config.url ? '***' : 'empty',
        key: this.config.key ? '***' : 'empty'
      });
    } catch (error) {
      console.warn('[SupabaseConnection] Failed to load config, using defaults:', error);
      if (!this.config.url) {
        const defaultConfigResponse = await fetch('/api/supabase-config');
        const defaultConfig = await defaultConfigResponse.json();
        this.config.url = defaultConfig.url || this.config.url;
        this.config.key = defaultConfig.key || this.config.key;
      }
    }
  }

  async attemptInitialConnection(retries = this.maxInitialRetries) {
    if (this.isConnecting) return Promise.resolve();
    
    this.isConnecting = true;
    this.connectionState = 'connecting';
    
    try {
      const response = await fetch('/api/supabase-config');
      const config = await response.json();
      
      if (config.url && config.key) {
        this.config.url = config.url.replace(/\/$/, '');
        this.config.key = config.key;
        this.connectionState = 'connected';
        this.connectionAttempts = 0;
        
        console.log('[SupabaseConnection] Initial connection successful');
        return true;
      }
      
      throw new Error('Missing URL or key in config');
    } catch (error) {
      this.connectionAttempts++;
      console.warn(`[SupabaseConnection] Connection attempt ${this.connectionAttempts}/${retries}:`, error.message);
      
      if (this.connectionAttempts < retries) {
        await this.delay(this.retryDelay);
        return this.attemptInitialConnection(retries - this.connectionAttempts);
      }
      
      this.connectionState = 'failed';
      this.notifySubscribers('connection_failed', error);
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  async reconnectWithBackoff(retries = this.maxReconnectAttempts) {
    if (this.connectionState === 'connected') return Promise.resolve(true);
    
    this.isConnecting = true;
    
    try {
      const response = await fetch('/api/supabase-config');
      const config = await response.json();
      
      if (config.url && config.key) {
        this.config.url = config.url.replace(/\/$/, '');
        this.config.key = config.key;
        this.connectionState = 'connected';
        this.connectionAttempts = 0;
        
        console.log('[SupabaseConnection] Reconnection successful');
        this.notifySubscribers('reconnected', null);
        return true;
      }
      
      throw new Error('Reconnection failed - missing config');
    } catch (error) {
      console.warn(`[SupabaseConnection] Reconnection attempt ${retries}/${this.maxReconnectAttempts}:`, error.message);
      
      if (retries > 0) {
        await this.delay(this.retryDelay * (this.maxReconnectAttempts - retries + 1));
        return this.reconnectWithBackoff(retries - 1);
      }
      
      this.connectionState = 'failed';
      this.notifySubscribers('reconnection_failed', error);
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  startAutoReconnection() {
    if (!this.config.autoReconnect) return;
    
    this.reconnectTimer = setInterval(async () => {
      if (this.connectionState !== 'connected' && !this.isConnecting) {
        try {
          await this.reconnectWithBackoff();
        } catch (error) {
          console.warn('[SupabaseConnection] Auto-reconnection failed:', error.message);
        }
      }
    }, this.reconnectInterval);
    
    console.log('[SupabaseConnection] Auto-reconnection started');
  }

  async attemptToReconnect(context = 'operation') {
    try {
      console.log(`[SupabaseConnection] Attempting to reconnect from ${context}...`);
      const reconnected = await this.reconnectWithBackoff(this.maxReconnectAttempts);
      if (reconnected) {
        this.notifySubscribers('reconnected', { context });
        return true;
      }
    } catch (error) {
      console.warn(`[SupabaseConnection] Reconnection from ${context} failed:`, error.message);
    }
    return false;
  }

  getConnectionState() {
    return this.connectionState;
  }

  isReady() {
    return this.connectionState === 'connected' && !!this.config.url && !!this.config.key;
  }

  makeAuthenticatedRequest(endpoint, options = {}) {
    if (!this.isReady()) {
      return Promise.reject(new Error('Not connected to Supabase'));
    }
    
    const url = `${this.config.url}${endpoint}`;
    const headers = {
      'apikey': this.config.key,
      'Authorization': `Bearer ${this.config.key}`,
      'Content-Type': 'application/json',
      ...options.headers
    };
    
    return fetch(url, { ...options, headers })
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.json();
      })
      .catch(error => {
        console.error('[SupabaseConnection] Request failed:', error);
        this.connectionState = 'failed';
        this.notifySubscribers('request_failed', error);
        return Promise.reject(error);
      });
  }

  subscribe(event, callback) {
    this.subscribers.push({ event, callback });
    return () => {
      this.subscribers = this.subscribers.filter(sub => sub.callback !== callback);
    };
  }

  notifySubscribers(event, data) {
    this.subscribers.forEach(subscriber => {
      try {
        if (subscriber.event === event || subscriber.event === 'any') {
          subscriber.callback(event, data);
        }
      } catch (error) {
        console.error('[SupabaseConnection] Subscriber error:', error);
      }
    });
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  cleanup() {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isInitialized = false;
    this.connectionState = 'disconnected';
    console.log('[SupabaseConnection] Cleanup completed');
  }
}

// Export for use in the application
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SupabaseConnectionManager;
}

// Global instance for backward compatibility
window.SupabaseConnection = new SupabaseConnectionManager();
