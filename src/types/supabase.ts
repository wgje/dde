export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      app_config: {
        Row: {
          created_at: string | null
          description: string | null
          key: string
          updated_at: string | null
          value: Json
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          key: string
          updated_at?: string | null
          value: Json
        }
        Update: {
          created_at?: string | null
          description?: string | null
          key?: string
          updated_at?: string | null
          value?: Json
        }
        Relationships: []
      }
      black_box_entries: {
        Row: {
          content: string
          created_at: string | null
          date: string
          deleted_at: string | null
          focus_meta: Json | null
          id: string
          is_archived: boolean
          is_completed: boolean
          is_read: boolean
          project_id: string | null
          snooze_count: number
          snooze_until: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          content: string
          created_at?: string | null
          date?: string
          deleted_at?: string | null
          focus_meta?: Json | null
          id: string
          is_archived?: boolean
          is_completed?: boolean
          is_read?: boolean
          project_id?: string | null
          snooze_count?: number
          snooze_until?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          content?: string
          created_at?: string | null
          date?: string
          deleted_at?: string | null
          focus_meta?: Json | null
          id?: string
          is_archived?: boolean
          is_completed?: boolean
          is_read?: boolean
          project_id?: string | null
          snooze_count?: number
          snooze_until?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "black_box_entries_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      circuit_breaker_logs: {
        Row: {
          blocked: boolean
          created_at: string
          details: Json | null
          id: string
          operation: string
          reason: string | null
          user_id: string
        }
        Insert: {
          blocked?: boolean
          created_at?: string
          details?: Json | null
          id?: string
          operation: string
          reason?: string | null
          user_id: string
        }
        Update: {
          blocked?: boolean
          created_at?: string
          details?: Json | null
          id?: string
          operation?: string
          reason?: string | null
          user_id?: string
        }
        Relationships: []
      }
      cleanup_logs: {
        Row: {
          created_at: string | null
          details: Json | null
          id: string
          type: string
        }
        Insert: {
          created_at?: string | null
          details?: Json | null
          id?: string
          type: string
        }
        Update: {
          created_at?: string | null
          details?: Json | null
          id?: string
          type?: string
        }
        Relationships: []
      }
      connection_tombstones: {
        Row: {
          connection_id: string
          deleted_at: string
          deleted_by: string | null
          project_id: string
        }
        Insert: {
          connection_id: string
          deleted_at?: string
          deleted_by?: string | null
          project_id: string
        }
        Update: {
          connection_id?: string
          deleted_at?: string
          deleted_by?: string | null
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "connection_tombstones_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      connections: {
        Row: {
          created_at: string | null
          deleted_at: string | null
          description: string | null
          id: string
          project_id: string
          source_id: string
          target_id: string
          title: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          project_id: string
          source_id: string
          target_id: string
          title?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          project_id?: string
          source_id?: string
          target_id?: string
          title?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "connections_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      focus_sessions: {
        Row: {
          ended_at: string | null
          id: string
          session_state: Json
          started_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          ended_at?: string | null
          id: string
          session_state: Json
          started_at: string
          updated_at?: string
          user_id: string
        }
        Update: {
          ended_at?: string | null
          id?: string
          session_state?: Json
          started_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          created_date: string | null
          data: Json | null
          deleted_at: string | null
          description: string | null
          id: string
          migrated_to_v2: boolean | null
          owner_id: string
          title: string | null
          updated_at: string | null
          version: number | null
        }
        Insert: {
          created_date?: string | null
          data?: Json | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          migrated_to_v2?: boolean | null
          owner_id: string
          title?: string | null
          updated_at?: string | null
          version?: number | null
        }
        Update: {
          created_date?: string | null
          data?: Json | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          migrated_to_v2?: boolean | null
          owner_id?: string
          title?: string | null
          updated_at?: string | null
          version?: number | null
        }
        Relationships: []
      }
      purge_rate_limits: {
        Row: {
          call_count: number | null
          user_id: string
          window_start: string | null
        }
        Insert: {
          call_count?: number | null
          user_id: string
          window_start?: string | null
        }
        Update: {
          call_count?: number | null
          user_id?: string
          window_start?: string | null
        }
        Relationships: []
      }
      routine_completions: {
        Row: {
          count: number
          date_key: string
          id: string
          routine_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          count?: number
          date_key: string
          id: string
          routine_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          count?: number
          date_key?: string
          id?: string
          routine_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "routine_completions_routine_id_fkey"
            columns: ["routine_id"]
            isOneToOne: false
            referencedRelation: "routine_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      routine_tasks: {
        Row: {
          created_at: string
          id: string
          is_enabled: boolean
          max_times_per_day: number
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id: string
          is_enabled?: boolean
          max_times_per_day?: number
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_enabled?: boolean
          max_times_per_day?: number
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      task_tombstones: {
        Row: {
          deleted_at: string
          deleted_by: string | null
          project_id: string
          task_id: string
        }
        Insert: {
          deleted_at?: string
          deleted_by?: string | null
          project_id: string
          task_id: string
        }
        Update: {
          deleted_at?: string
          deleted_by?: string | null
          project_id?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_tombstones_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          attachments: Json | null
          cognitive_load: string | null
          content: string | null
          created_at: string | null
          deleted_at: string | null
          due_date: string | null
          expected_minutes: number | null
          id: string
          order: number | null
          parent_id: string | null
          parking_meta: Json | null
          priority: string | null
          project_id: string
          rank: number | null
          short_id: string | null
          stage: number | null
          status: string | null
          tags: Json | null
          title: string
          updated_at: string | null
          wait_minutes: number | null
          x: number | null
          y: number | null
        }
        Insert: {
          attachments?: Json | null
          cognitive_load?: string | null
          content?: string | null
          created_at?: string | null
          deleted_at?: string | null
          due_date?: string | null
          expected_minutes?: number | null
          id?: string
          order?: number | null
          parent_id?: string | null
          parking_meta?: Json | null
          priority?: string | null
          project_id: string
          rank?: number | null
          short_id?: string | null
          stage?: number | null
          status?: string | null
          tags?: Json | null
          title?: string
          updated_at?: string | null
          wait_minutes?: number | null
          x?: number | null
          y?: number | null
        }
        Update: {
          attachments?: Json | null
          cognitive_load?: string | null
          content?: string | null
          created_at?: string | null
          deleted_at?: string | null
          due_date?: string | null
          expected_minutes?: number | null
          id?: string
          order?: number | null
          parent_id?: string | null
          parking_meta?: Json | null
          priority?: string | null
          project_id?: string
          rank?: number | null
          short_id?: string | null
          stage?: number | null
          status?: string | null
          tags?: Json | null
          title?: string
          updated_at?: string | null
          wait_minutes?: number | null
          x?: number | null
          y?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      transcription_usage: {
        Row: {
          audio_seconds: number | null
          created_at: string | null
          date: string
          id: string
          user_id: string | null
        }
        Insert: {
          audio_seconds?: number | null
          created_at?: string | null
          date?: string
          id: string
          user_id?: string | null
        }
        Update: {
          audio_seconds?: number | null
          created_at?: string | null
          date?: string
          id?: string
          user_id?: string | null
        }
        Relationships: []
      }
      user_preferences: {
        Row: {
          auto_resolve_conflicts: boolean | null
          color_mode: string | null
          created_at: string | null
          floating_window_pref: string | null
          focus_preferences: Json | null
          id: string
          layout_direction: string | null
          local_backup_enabled: boolean | null
          local_backup_interval_ms: number | null
          theme: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          auto_resolve_conflicts?: boolean | null
          color_mode?: string | null
          created_at?: string | null
          floating_window_pref?: string | null
          focus_preferences?: Json | null
          id?: string
          layout_direction?: string | null
          local_backup_enabled?: boolean | null
          local_backup_interval_ms?: number | null
          theme?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          auto_resolve_conflicts?: boolean | null
          color_mode?: string | null
          created_at?: string | null
          floating_window_pref?: string | null
          focus_preferences?: Json | null
          id?: string
          layout_direction?: string | null
          local_backup_enabled?: boolean | null
          local_backup_interval_ms?: number | null
          theme?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      active_connections: {
        Row: {
          created_at: string | null
          deleted_at: string | null
          description: string | null
          id: string | null
          project_id: string | null
          source_id: string | null
          target_id: string | null
          title: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string | null
          project_id?: string | null
          source_id?: string | null
          target_id?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string | null
          project_id?: string | null
          source_id?: string | null
          target_id?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "connections_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      active_tasks: {
        Row: {
          attachments: Json | null
          content: string | null
          created_at: string | null
          deleted_at: string | null
          due_date: string | null
          id: string | null
          order: number | null
          parent_id: string | null
          priority: string | null
          project_id: string | null
          rank: number | null
          short_id: string | null
          stage: number | null
          status: string | null
          tags: Json | null
          title: string | null
          updated_at: string | null
          x: number | null
          y: number | null
        }
        Insert: {
          attachments?: Json | null
          content?: string | null
          created_at?: string | null
          deleted_at?: string | null
          due_date?: string | null
          id?: string | null
          order?: number | null
          parent_id?: string | null
          priority?: string | null
          project_id?: string | null
          rank?: number | null
          short_id?: string | null
          stage?: number | null
          status?: string | null
          tags?: Json | null
          title?: string | null
          updated_at?: string | null
          x?: number | null
          y?: number | null
        }
        Update: {
          attachments?: Json | null
          content?: string | null
          created_at?: string | null
          deleted_at?: string | null
          due_date?: string | null
          id?: string | null
          order?: number | null
          parent_id?: string | null
          priority?: string | null
          project_id?: string | null
          rank?: number | null
          short_id?: string | null
          stage?: number | null
          status?: string | null
          tags?: Json | null
          title?: string | null
          updated_at?: string | null
          x?: number | null
          y?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "active_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      append_task_attachment: {
        Args: { p_attachment: Json; p_task_id: string }
        Returns: boolean
      }
      batch_upsert_tasks: {
        Args: { p_project_id: string; p_tasks: Json[] }
        Returns: number
      }
      cleanup_cron_job_run_details: {
        Args: { p_max_age?: string }
        Returns: number
      }
      cleanup_deleted_attachments: {
        Args: { retention_days?: number }
        Returns: {
          deleted_count: number
          storage_paths: string[]
        }[]
      }
      cleanup_expired_scan_records: { Args: never; Returns: number }
      cleanup_old_deleted_connections: { Args: never; Returns: number }
      cleanup_old_deleted_tasks: { Args: never; Returns: number }
      cleanup_old_logs: { Args: never; Returns: number }
      cleanup_personal_retention_artifacts: { Args: never; Returns: Json }
      current_user_id: { Args: never; Returns: string }
      get_accessible_project_probe: {
        Args: { p_project_id: string }
        Returns: {
          accessible: boolean
          project_id: string
          watermark: string | null
        }[]
      }
      get_all_projects_data: {
        Args: { p_since_timestamp?: string }
        Returns: Json
      }
      get_black_box_sync_watermark: { Args: never; Returns: string | null }
      get_dashboard_stats: { Args: never; Returns: Json }
      get_full_project_data: { Args: { p_project_id: string }; Returns: Json }
      get_project_sync_watermark: {
        Args: { p_project_id: string }
        Returns: string | null
      }
      get_projects_list: {
        Args: { p_limit?: number; p_offset?: number }
        Returns: Json
      }
      get_resume_recovery_probe: {
        Args: { p_project_id?: string | null }
        Returns: {
          active_accessible: boolean
          active_project_id: string | null
          active_watermark: string | null
          blackbox_watermark: string | null
          projects_watermark: string | null
          server_now: string | null
        }[]
      }
      get_server_time: { Args: never; Returns: string }
      get_user_projects_meta: {
        Args: { p_since_timestamp?: string }
        Returns: Json
      }
      get_user_projects_watermark: { Args: never; Returns: string | null }
      get_vault_secret: { Args: { p_name: string }; Returns: string }
      is_connection_tombstoned: {
        Args: { p_connection_id: string }
        Returns: boolean
      }
      is_task_tombstoned: { Args: { p_task_id: string }; Returns: boolean }
      list_project_heads_since: {
        Args: { p_since?: string }
        Returns: {
          project_id: string
          updated_at: string
          version: number
        }[]
      }
      migrate_all_projects_to_v2: {
        Args: never
        Returns: {
          connections_migrated: number
          errors: string[]
          project_id: string
          project_title: string
          tasks_migrated: number
        }[]
      }
      migrate_project_data_to_v2: {
        Args: { p_project_id: string }
        Returns: {
          connections_migrated: number
          errors: string[]
          tasks_migrated: number
        }[]
      }
      purge_tasks: { Args: { p_task_ids: string[] }; Returns: number }
      purge_tasks_v2: {
        Args: { p_project_id: string; p_task_ids: string[] }
        Returns: number
      }
      purge_tasks_v3: {
        Args: { p_project_id: string; p_task_ids: string[] }
        Returns: Database["public"]["CompositeTypes"]["purge_result"]
        SetofOptions: {
          from: "*"
          to: "purge_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      remove_task_attachment: {
        Args: { p_attachment_id: string; p_task_id: string }
        Returns: boolean
      }
      safe_delete_tasks: {
        Args: { p_project_id: string; p_task_ids: string[] }
        Returns: number
      }
      user_accessible_project_ids: { Args: never; Returns: string[] }
      user_has_project_access: {
        Args: { p_project_id: string }
        Returns: boolean
      }
      user_is_project_owner: {
        Args: { p_project_id: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      purge_result: {
        purged_count: number | null
        attachment_paths: string[] | null
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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

type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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

type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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

type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

