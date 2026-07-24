-- IPE Learning OS normalized storage v2
-- Run once in Supabase SQL Editor. This does not delete the legacy
-- learning_os_snapshots table; it remains available for manual recovery.

create table if not exists public.ipe_workspaces (
  sync_id text primary key,
  write_hash text not null,
  head_revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ipe_revisions (
  sync_id text not null references public.ipe_workspaces(sync_id) on delete cascade,
  revision bigint not null,
  operation_id uuid not null,
  device_id text not null,
  payload_hash text not null,
  app_state jsonb not null,
  atlas_state jsonb not null,
  bridge_state jsonb not null,
  concept_count integer not null,
  bridge_link_count integer not null,
  created_at timestamptz not null default now(),
  primary key (sync_id, revision),
  unique (sync_id, operation_id)
);

create table if not exists public.ipe_app_state (
  sync_id text primary key references public.ipe_workspaces(sync_id) on delete cascade,
  state jsonb not null,
  revision bigint not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.ipe_concepts (
  sync_id text not null references public.ipe_workspaces(sync_id) on delete cascade,
  concept_id text not null,
  title text not null default '',
  domain text not null default '',
  definition text not null default '',
  concept_role text not null default 'general',
  importance numeric not null default 0,
  order_index integer not null,
  created_at timestamptz,
  updated_at timestamptz,
  revision bigint not null,
  primary key (sync_id, concept_id),
  check (concept_role in ('core','support','general'))
);

create table if not exists public.ipe_concept_lines (
  sync_id text not null,
  concept_id text not null,
  line_id text not null,
  section text not null,
  body text not null default '',
  order_index integer not null,
  revision bigint not null,
  primary key (sync_id, line_id),
  foreign key (sync_id, concept_id)
    references public.ipe_concepts(sync_id, concept_id) on delete cascade,
  check (section in ('explanation','purpose','conditions','rules','constraints','exceptions','examples'))
);

create table if not exists public.ipe_line_keywords (
  sync_id text not null,
  line_id text not null,
  keyword text not null,
  order_index integer not null,
  revision bigint not null,
  primary key (sync_id, line_id, keyword),
  foreign key (sync_id, line_id)
    references public.ipe_concept_lines(sync_id, line_id) on delete cascade
);

create table if not exists public.ipe_concept_relations (
  sync_id text not null,
  from_concept_id text not null,
  to_concept_id text not null,
  relation_type text not null,
  revision bigint not null,
  primary key (sync_id, from_concept_id, to_concept_id, relation_type),
  foreign key (sync_id, from_concept_id)
    references public.ipe_concepts(sync_id, concept_id) on delete cascade,
  foreign key (sync_id, to_concept_id)
    references public.ipe_concepts(sync_id, concept_id) on delete cascade,
  check (relation_type in ('parent','related')),
  check (from_concept_id <> to_concept_id)
);

create table if not exists public.ipe_study_concept_links (
  sync_id text not null,
  item_id text not null,
  concept_id text not null,
  role text not null default '참조',
  revision bigint not null,
  primary key (sync_id, item_id, concept_id),
  foreign key (sync_id, concept_id)
    references public.ipe_concepts(sync_id, concept_id) on delete cascade
);

create table if not exists public.ipe_orphan_study_links (
  sync_id text not null references public.ipe_workspaces(sync_id) on delete cascade,
  item_id text not null,
  missing_concept_id text not null,
  role text not null default '참조',
  reason text not null default 'missing_concept_body',
  archived_at timestamptz not null default now(),
  revision bigint not null,
  primary key (sync_id, item_id, missing_concept_id)
);

create table if not exists public.ipe_frames (
  sync_id text not null,
  frame_id text not null,
  title text not null default '',
  frame_type text not null default '',
  anchor_concept_id text,
  description text not null default '',
  config jsonb not null default '{}'::jsonb,
  order_index integer not null,
  revision bigint not null,
  primary key (sync_id, frame_id),
  foreign key (sync_id, anchor_concept_id)
    references public.ipe_concepts(sync_id, concept_id) on delete set null
);

create table if not exists public.ipe_frame_members (
  sync_id text not null,
  frame_id text not null,
  member_id text not null,
  member_kind text not null,
  order_index integer not null,
  revision bigint not null,
  primary key (sync_id, frame_id, member_id),
  foreign key (sync_id, frame_id)
    references public.ipe_frames(sync_id, frame_id) on delete cascade,
  check (member_kind in ('concept','object'))
);

create table if not exists public.ipe_objects (
  sync_id text not null references public.ipe_workspaces(sync_id) on delete cascade,
  object_id text not null,
  payload jsonb not null,
  order_index integer not null,
  revision bigint not null,
  primary key (sync_id, object_id)
);

create table if not exists public.ipe_keywords (
  sync_id text not null references public.ipe_workspaces(sync_id) on delete cascade,
  keyword text not null,
  order_index integer not null,
  revision bigint not null,
  primary key (sync_id, keyword)
);

create index if not exists ipe_revisions_recent
  on public.ipe_revisions(sync_id, revision desc);
create index if not exists ipe_lines_by_concept
  on public.ipe_concept_lines(sync_id, concept_id, section, order_index);
create index if not exists ipe_study_links_by_item
  on public.ipe_study_concept_links(sync_id, item_id);

alter table public.ipe_workspaces enable row level security;
alter table public.ipe_revisions enable row level security;
alter table public.ipe_app_state enable row level security;
alter table public.ipe_concepts enable row level security;
alter table public.ipe_concept_lines enable row level security;
alter table public.ipe_line_keywords enable row level security;
alter table public.ipe_concept_relations enable row level security;
alter table public.ipe_study_concept_links enable row level security;
alter table public.ipe_orphan_study_links enable row level security;
alter table public.ipe_frames enable row level security;
alter table public.ipe_frame_members enable row level security;
alter table public.ipe_objects enable row level security;
alter table public.ipe_keywords enable row level security;

revoke all on public.ipe_workspaces from anon, authenticated;
revoke all on public.ipe_revisions from anon, authenticated;
revoke all on public.ipe_app_state from anon, authenticated;
revoke all on public.ipe_concepts from anon, authenticated;
revoke all on public.ipe_concept_lines from anon, authenticated;
revoke all on public.ipe_line_keywords from anon, authenticated;
revoke all on public.ipe_concept_relations from anon, authenticated;
revoke all on public.ipe_study_concept_links from anon, authenticated;
revoke all on public.ipe_orphan_study_links from anon, authenticated;
revoke all on public.ipe_frames from anon, authenticated;
revoke all on public.ipe_frame_members from anon, authenticated;
revoke all on public.ipe_objects from anon, authenticated;
revoke all on public.ipe_keywords from anon, authenticated;

create or replace function public.ipe_assert_state(
  p_atlas jsonb,
  p_bridge jsonb
) returns void
language plpgsql
immutable
as $$
declare
  v_concepts jsonb := coalesce(p_atlas->'concepts', '[]'::jsonb);
  v_links jsonb := coalesce(p_bridge->'links', '[]'::jsonb);
  v_orphan_links jsonb := coalesce(p_bridge->'orphanedLinks', '[]'::jsonb);
  v_count integer;
  v_distinct integer;
  v_dangling integer;
begin
  if jsonb_typeof(v_concepts) <> 'array' then
    raise exception using errcode='22023', message='atlas.concepts must be an array';
  end if;
  if jsonb_typeof(v_links) <> 'array' then
    raise exception using errcode='22023', message='bridge.links must be an array';
  end if;
  if jsonb_typeof(v_orphan_links) <> 'array' then
    raise exception using errcode='22023', message='bridge.orphanedLinks must be an array';
  end if;

  select count(*), count(distinct c->>'id')
    into v_count, v_distinct
  from jsonb_array_elements(v_concepts) c;
  if v_count <> v_distinct or exists(
    select 1 from jsonb_array_elements(v_concepts) c
    where coalesce(c->>'id','') = ''
  ) then
    raise exception using errcode='23505', message='duplicate or empty concept id';
  end if;
  if v_count = 0 and jsonb_array_length(v_links) + jsonb_array_length(v_orphan_links) > 0 then
    raise exception using errcode='23503', message='commit rejected: empty atlas cannot retain study links';
  end if;

  select count(*) into v_dangling
  from jsonb_array_elements(v_links) l
  where not exists (
    select 1 from jsonb_array_elements(v_concepts) c
    where c->>'id' = l->>'conceptId'
  );
  if v_dangling > 0 then
    raise exception using errcode='23503',
      message=format('commit rejected: %s study links reference missing concepts',v_dangling);
  end if;

  select count(*) into v_dangling
  from jsonb_array_elements(coalesce(p_atlas->'frames','[]'::jsonb)) f,
       jsonb_array_elements(coalesce(f->'members','[]'::jsonb)) m
  where not exists(select 1 from jsonb_array_elements(v_concepts) c where c->>'id'=trim(both '"' from m::text))
    and not exists(select 1 from jsonb_array_elements(coalesce(p_atlas->'objects','[]'::jsonb)) o where o->>'id'=trim(both '"' from m::text));
  if v_dangling > 0 then
    raise exception using errcode='23503', message=format('commit rejected: %s frame members reference missing entities',v_dangling);
  end if;
end;
$$;

create or replace function public.ipe_commit_state(
  p_sync_id text,
  p_write_hash text,
  p_expected_revision bigint,
  p_operation_id uuid,
  p_device_id text,
  p_payload_hash text,
  p_app jsonb,
  p_atlas jsonb,
  p_bridge jsonb
) returns table(revision bigint, committed_at timestamptz, replayed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace public.ipe_workspaces%rowtype;
  v_revision bigint;
  v_now timestamptz := now();
  v_concept jsonb;
  v_line jsonb;
  v_keyword jsonb;
  v_parent jsonb;
  v_related jsonb;
  v_frame jsonb;
  v_member jsonb;
  v_link jsonb;
  v_object jsonb;
  v_section text;
  v_index integer;
  v_inner_index integer;
begin
  if coalesce(p_sync_id,'')='' or coalesce(p_write_hash,'')='' then
    raise exception using errcode='22023', message='missing workspace credentials';
  end if;
  if coalesce(p_operation_id::text,'')='' then
    raise exception using errcode='22023', message='missing operation id';
  end if;
  perform public.ipe_assert_state(p_atlas,p_bridge);

  insert into public.ipe_workspaces(sync_id,write_hash,head_revision)
    values(p_sync_id,p_write_hash,0)
    on conflict(sync_id) do nothing;

  select * into v_workspace from public.ipe_workspaces
    where sync_id=p_sync_id for update;
  if v_workspace.write_hash <> p_write_hash then
    raise exception using errcode='28000', message='invalid sync key';
  end if;

  select r.revision into v_revision from public.ipe_revisions r
    where r.sync_id=p_sync_id and r.operation_id=p_operation_id;
  if found then
    return query select v_revision,
      (select r.created_at from public.ipe_revisions r where r.sync_id=p_sync_id and r.revision=v_revision),
      true;
    return;
  end if;

  if v_workspace.head_revision <> p_expected_revision then
    raise exception using errcode='40001',
      message=format('revision conflict: expected %s, server is %s',p_expected_revision,v_workspace.head_revision),
      detail=json_build_object('expected',p_expected_revision,'actual',v_workspace.head_revision)::text;
  end if;
  v_revision := v_workspace.head_revision + 1;

  -- Replace the normalized current projection inside one transaction. The
  -- append-only ipe_revisions row below retains every committed generation.
  delete from public.ipe_app_state where sync_id=p_sync_id;
  delete from public.ipe_line_keywords where sync_id=p_sync_id;
  delete from public.ipe_concept_lines where sync_id=p_sync_id;
  delete from public.ipe_concept_relations where sync_id=p_sync_id;
  delete from public.ipe_study_concept_links where sync_id=p_sync_id;
  delete from public.ipe_orphan_study_links where sync_id=p_sync_id;
  delete from public.ipe_frame_members where sync_id=p_sync_id;
  delete from public.ipe_frames where sync_id=p_sync_id;
  delete from public.ipe_objects where sync_id=p_sync_id;
  delete from public.ipe_keywords where sync_id=p_sync_id;
  delete from public.ipe_concepts where sync_id=p_sync_id;

  insert into public.ipe_app_state(sync_id,state,revision,updated_at)
    values(p_sync_id,coalesce(p_app,'{}'::jsonb),v_revision,v_now);

  v_index := 0;
  for v_concept in select value from jsonb_array_elements(coalesce(p_atlas->'concepts','[]'::jsonb)) loop
    insert into public.ipe_concepts(sync_id,concept_id,title,domain,definition,concept_role,importance,order_index,created_at,updated_at,revision)
    values(p_sync_id,v_concept->>'id',coalesce(v_concept->>'title',''),coalesce(v_concept->>'domain',''),coalesce(v_concept->>'definition',''),
      case when v_concept->>'conceptRole' in ('core','support','general') then v_concept->>'conceptRole' else 'general' end,
      coalesce(nullif(v_concept->>'importance','')::numeric,0),v_index,nullif(v_concept->>'createdAt','')::timestamptz,
      nullif(v_concept->>'updatedAt','')::timestamptz,v_revision);
    v_index := v_index + 1;
  end loop;

  for v_concept in select value from jsonb_array_elements(coalesce(p_atlas->'concepts','[]'::jsonb)) loop
    foreach v_section in array array['explanation','purpose','conditions','rules','constraints','exceptions','examples'] loop
      v_inner_index := 0;
      for v_line in select value from jsonb_array_elements(coalesce(v_concept->'sections'->v_section,'[]'::jsonb)) loop
        insert into public.ipe_concept_lines(sync_id,concept_id,line_id,section,body,order_index,revision)
          values(p_sync_id,v_concept->>'id',v_line->>'id',v_section,coalesce(v_line->>'text',''),v_inner_index,v_revision);
        for v_keyword in select value from jsonb_array_elements(coalesce(v_line->'keywords','[]'::jsonb)) with ordinality loop
          insert into public.ipe_line_keywords(sync_id,line_id,keyword,order_index,revision)
            values(p_sync_id,v_line->>'id',trim(both '"' from v_keyword::text),0,v_revision)
            on conflict do nothing;
        end loop;
        v_inner_index := v_inner_index + 1;
      end loop;
    end loop;

    for v_parent in select value from jsonb_array_elements(coalesce(v_concept->'parents','[]'::jsonb)) loop
      insert into public.ipe_concept_relations(sync_id,from_concept_id,to_concept_id,relation_type,revision)
        values(p_sync_id,trim(both '"' from v_parent::text),v_concept->>'id','parent',v_revision)
        on conflict do nothing;
    end loop;
    for v_related in select value from jsonb_array_elements(coalesce(v_concept->'related','[]'::jsonb)) loop
      if trim(both '"' from v_related::text) <> v_concept->>'id' then
        insert into public.ipe_concept_relations(sync_id,from_concept_id,to_concept_id,relation_type,revision)
          values(p_sync_id,v_concept->>'id',trim(both '"' from v_related::text),'related',v_revision)
          on conflict do nothing;
      end if;
    end loop;
  end loop;

  v_index := 0;
  for v_frame in select value from jsonb_array_elements(coalesce(p_atlas->'frames','[]'::jsonb)) loop
    insert into public.ipe_frames(sync_id,frame_id,title,frame_type,anchor_concept_id,description,config,order_index,revision)
      values(p_sync_id,v_frame->>'id',coalesce(v_frame->>'title',''),coalesce(v_frame->>'type',''),nullif(v_frame->>'anchorId',''),
        coalesce(v_frame->>'description',''),coalesce(v_frame->'config','{}'::jsonb),v_index,v_revision);
    v_inner_index := 0;
    for v_member in select value from jsonb_array_elements(coalesce(v_frame->'members','[]'::jsonb)) loop
      insert into public.ipe_frame_members(sync_id,frame_id,member_id,member_kind,order_index,revision)
        values(p_sync_id,v_frame->>'id',trim(both '"' from v_member::text),
          case when exists(select 1 from jsonb_array_elements(coalesce(p_atlas->'concepts','[]'::jsonb)) c where c->>'id'=trim(both '"' from v_member::text)) then 'concept' else 'object' end,
          v_inner_index,v_revision)
        on conflict do nothing;
      v_inner_index := v_inner_index + 1;
    end loop;
    v_index := v_index + 1;
  end loop;

  for v_link in select value from jsonb_array_elements(coalesce(p_bridge->'links','[]'::jsonb)) loop
    insert into public.ipe_study_concept_links(sync_id,item_id,concept_id,role,revision)
      values(p_sync_id,v_link->>'itemId',v_link->>'conceptId',coalesce(v_link->>'role','참조'),v_revision)
      on conflict (sync_id,item_id,concept_id) do update
        set role=excluded.role, revision=excluded.revision;
  end loop;
  for v_link in select value from jsonb_array_elements(coalesce(p_bridge->'orphanedLinks','[]'::jsonb)) loop
    insert into public.ipe_orphan_study_links(sync_id,item_id,missing_concept_id,role,reason,revision)
      values(p_sync_id,v_link->>'itemId',v_link->>'conceptId',coalesce(v_link->>'role','참조'),coalesce(v_link->>'reason','missing_concept_body'),v_revision)
      on conflict (sync_id,item_id,missing_concept_id) do update
        set role=excluded.role,reason=excluded.reason,revision=excluded.revision,archived_at=now();
  end loop;

  v_index := 0;
  for v_object in select value from jsonb_array_elements(coalesce(p_atlas->'objects','[]'::jsonb)) loop
    insert into public.ipe_objects(sync_id,object_id,payload,order_index,revision)
      values(p_sync_id,coalesce(v_object->>'id','object_'||v_index),v_object,v_index,v_revision);
    v_index := v_index + 1;
  end loop;
  v_index := 0;
  for v_keyword in select value from jsonb_array_elements(coalesce(p_atlas->'keywords','[]'::jsonb)) loop
    insert into public.ipe_keywords(sync_id,keyword,order_index,revision)
      values(p_sync_id,trim(both '"' from v_keyword::text),v_index,v_revision)
      on conflict do nothing;
    v_index := v_index + 1;
  end loop;

  insert into public.ipe_revisions(sync_id,revision,operation_id,device_id,payload_hash,app_state,atlas_state,bridge_state,concept_count,bridge_link_count,created_at)
  values(p_sync_id,v_revision,p_operation_id,left(coalesce(p_device_id,'unknown'),200),p_payload_hash,
    coalesce(p_app,'{}'::jsonb),coalesce(p_atlas,'{}'::jsonb),coalesce(p_bridge,'{}'::jsonb),
    jsonb_array_length(coalesce(p_atlas->'concepts','[]'::jsonb)),
    jsonb_array_length(coalesce(p_bridge->'links','[]'::jsonb)),v_now);

  update public.ipe_workspaces set head_revision=v_revision,updated_at=v_now where sync_id=p_sync_id;
  return query select v_revision,v_now,false;
end;
$$;

create or replace function public.ipe_load_head(
  p_sync_id text,
  p_write_hash text
) returns table(
  revision bigint,
  operation_id uuid,
  device_id text,
  payload_hash text,
  app_state jsonb,
  atlas_state jsonb,
  bridge_state jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists(select 1 from public.ipe_workspaces where sync_id=p_sync_id and write_hash=p_write_hash) then
    raise exception using errcode='28000', message='invalid sync key';
  end if;
  return query
    select r.revision,r.operation_id,r.device_id,r.payload_hash,r.app_state,r.atlas_state,r.bridge_state,r.created_at
    from public.ipe_revisions r join public.ipe_workspaces w on w.sync_id=r.sync_id and w.head_revision=r.revision
    where r.sync_id=p_sync_id;
end;
$$;

create or replace function public.ipe_list_revisions(
  p_sync_id text,
  p_write_hash text,
  p_limit integer default 30
) returns table(revision bigint,operation_id uuid,device_id text,payload_hash text,concept_count integer,bridge_link_count integer,created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists(select 1 from public.ipe_workspaces where sync_id=p_sync_id and write_hash=p_write_hash) then
    raise exception using errcode='28000', message='invalid sync key';
  end if;
  return query select r.revision,r.operation_id,r.device_id,r.payload_hash,r.concept_count,r.bridge_link_count,r.created_at
    from public.ipe_revisions r where r.sync_id=p_sync_id order by r.revision desc limit greatest(1,least(coalesce(p_limit,30),200));
end;
$$;

create or replace function public.ipe_load_revision(
  p_sync_id text,
  p_write_hash text,
  p_revision bigint
) returns table(
  revision bigint,
  operation_id uuid,
  device_id text,
  payload_hash text,
  app_state jsonb,
  atlas_state jsonb,
  bridge_state jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists(select 1 from public.ipe_workspaces where sync_id=p_sync_id and write_hash=p_write_hash) then
    raise exception using errcode='28000', message='invalid sync key';
  end if;
  return query
    select r.revision,r.operation_id,r.device_id,r.payload_hash,r.app_state,r.atlas_state,r.bridge_state,r.created_at
    from public.ipe_revisions r
    where r.sync_id=p_sync_id and r.revision=p_revision
    limit 1;
end;
$$;

grant execute on function public.ipe_commit_state(text,text,bigint,uuid,text,text,jsonb,jsonb,jsonb) to anon, authenticated;
grant execute on function public.ipe_load_head(text,text) to anon, authenticated;
grant execute on function public.ipe_list_revisions(text,text,integer) to anon, authenticated;
grant execute on function public.ipe_load_revision(text,text,bigint) to anon, authenticated;

notify pgrst, 'reload schema';
