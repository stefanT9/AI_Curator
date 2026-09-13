export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      ai_enrichment_calls: {
        Row: {
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      artworks: {
        Row: {
          artist_id: string
          created_at: string
          description: string | null
          id: string
          image_path: string
          tags: string[]
          title: string
          updated_at: string
        }
        Insert: {
          artist_id: string
          created_at?: string
          description?: string | null
          id?: string
          image_path: string
          tags?: string[]
          title: string
          updated_at?: string
        }
        Update: {
          artist_id?: string
          created_at?: string
          description?: string | null
          id?: string
          image_path?: string
          tags?: string[]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "artworks_artist_id_fkey"
            columns: ["artist_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      auctions: {
        Row: {
          artwork_id: string
          cancelled_at: string | null
          closed_at: string | null
          created_at: string
          ends_at: string
          id: string
          seller_id: string
          starting_price_cents: number
          updated_at: string
          winning_amount_cents: number | null
          winning_bid_id: string | null
        }
        Insert: {
          artwork_id: string
          cancelled_at?: string | null
          closed_at?: string | null
          created_at?: string
          ends_at: string
          id?: string
          seller_id: string
          starting_price_cents: number
          updated_at?: string
          winning_amount_cents?: number | null
          winning_bid_id?: string | null
        }
        Update: {
          artwork_id?: string
          cancelled_at?: string | null
          closed_at?: string | null
          created_at?: string
          ends_at?: string
          id?: string
          seller_id?: string
          starting_price_cents?: number
          updated_at?: string
          winning_amount_cents?: number | null
          winning_bid_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "auctions_artwork_id_fkey"
            columns: ["artwork_id"]
            isOneToOne: false
            referencedRelation: "artworks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auctions_seller_id_fkey"
            columns: ["seller_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auctions_winning_bid_id_fkey"
            columns: ["winning_bid_id"]
            isOneToOne: false
            referencedRelation: "bids"
            referencedColumns: ["id"]
          },
        ]
      }
      bids: {
        Row: {
          amount_cents: number
          auction_id: string
          bidder_id: string
          created_at: string
          id: string
          updated_at: string
        }
        Insert: {
          amount_cents: number
          auction_id: string
          bidder_id: string
          created_at?: string
          id?: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          auction_id?: string
          bidder_id?: string
          created_at?: string
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bids_auction_id_fkey"
            columns: ["auction_id"]
            isOneToOne: false
            referencedRelation: "auctions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bids_bidder_id_fkey"
            columns: ["bidder_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      email_outbox: {
        Row: {
          attempts: number
          auction_id: string | null
          created_at: string
          id: string
          kind: string
          last_error: string | null
          payload: Json
          recipient_email: string
          sent_at: string | null
          status: string
        }
        Insert: {
          attempts?: number
          auction_id?: string | null
          created_at?: string
          id?: string
          kind: string
          last_error?: string | null
          payload: Json
          recipient_email: string
          sent_at?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          auction_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          last_error?: string | null
          payload?: Json
          recipient_email?: string
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_outbox_auction_id_fkey"
            columns: ["auction_id"]
            isOneToOne: false
            referencedRelation: "auctions"
            referencedColumns: ["id"]
          },
        ]
      }
      email_sends: {
        Row: {
          actor_id: string | null
          created_at: string
          id: string
          kind: string
          provider_id: string | null
          reason: string | null
          recipient: string
          status: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          id?: string
          kind: string
          provider_id?: string | null
          reason?: string | null
          recipient: string
          status: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          provider_id?: string | null
          reason?: string | null
          recipient?: string
          status?: string
        }
        Relationships: []
      }
      interactions: {
        Row: {
          action: string
          artwork_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          action: string
          artwork_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          action?: string
          artwork_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "interactions_artwork_id_fkey"
            columns: ["artwork_id"]
            isOneToOne: false
            referencedRelation: "artworks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          auction_emails_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          auction_emails_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          auction_emails_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          onboarded_at: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
          onboarded_at?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          onboarded_at?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cancel_auction: { Args: { p_auction_id: string }; Returns: boolean }
      claim_enrichment_slot: {
        Args: { p_daily_limit?: number; p_hourly_limit?: number }
        Returns: boolean
      }
      claim_pending_emails: {
        Args: { p_limit?: number; p_secret: string }
        Returns: {
          id: string
          kind: string
          payload: Json
          recipient_email: string
        }[]
      }
      close_due_auctions: { Args: { p_now?: string }; Returns: number }
      create_auction: {
        Args: {
          p_artwork_id: string
          p_duration_hours: number
          p_starting_price_cents: number
        }
        Returns: string
      }
      mark_email_sent: {
        Args: {
          p_id: string
          p_provider_id?: string
          p_reason?: string
          p_secret: string
          p_status: string
        }
        Returns: undefined
      }
      place_bid: {
        Args: { p_amount_cents: number; p_auction_id: string }
        Returns: undefined
      }
      record_email_send: {
        Args: {
          p_kind: string
          p_provider_id?: string
          p_reason?: string
          p_recipient: string
          p_status: string
        }
        Returns: string
      }
      set_auction_emails_enabled: {
        Args: { p_enabled: boolean; p_secret: string; p_user_id: string }
        Returns: undefined
      }
      swipe_deck: {
        Args: { p_limit?: number }
        Returns: {
          artist_id: string
          created_at: string
          description: string | null
          id: string
          image_path: string
          tags: string[]
          title: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "artworks"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      verify_drain_secret: { Args: { p_secret: string }; Returns: boolean }
      verify_unsubscribe_secret: {
        Args: { p_secret: string }
        Returns: boolean
      }
    }
    Enums: {
      user_role: "collector" | "artist"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      user_role: ["collector", "artist"],
    },
  },
} as const

