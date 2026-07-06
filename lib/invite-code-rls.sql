drop policy if exists "authenticated read field values" on workbook_field_values;
create policy "authenticated read field values"
on workbook_field_values for select
to authenticated
using (true);

drop policy if exists "authenticated insert field values" on workbook_field_values;
create policy "authenticated insert field values"
on workbook_field_values for insert
to authenticated
with check (true);

drop policy if exists "authenticated update field values" on workbook_field_values;
create policy "authenticated update field values"
on workbook_field_values for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated delete field values" on workbook_field_values;
create policy "authenticated delete field values"
on workbook_field_values for delete
to authenticated
using (true);

drop policy if exists "authenticated read custom rows" on workbook_custom_rows;
create policy "authenticated read custom rows"
on workbook_custom_rows for select
to authenticated
using (true);

drop policy if exists "authenticated insert custom rows" on workbook_custom_rows;
create policy "authenticated insert custom rows"
on workbook_custom_rows for insert
to authenticated
with check (true);

drop policy if exists "authenticated update custom rows" on workbook_custom_rows;
create policy "authenticated update custom rows"
on workbook_custom_rows for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated delete custom rows" on workbook_custom_rows;
create policy "authenticated delete custom rows"
on workbook_custom_rows for delete
to authenticated
using (true);

drop policy if exists "authenticated read suggestions" on update_suggestions;
create policy "authenticated read suggestions"
on update_suggestions for select
to authenticated
using (true);

drop policy if exists "authenticated insert suggestions" on update_suggestions;
create policy "authenticated insert suggestions"
on update_suggestions for insert
to authenticated
with check (true);

drop policy if exists "authenticated update suggestions" on update_suggestions;
create policy "authenticated update suggestions"
on update_suggestions for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated delete suggestions" on update_suggestions;
create policy "authenticated delete suggestions"
on update_suggestions for delete
to authenticated
using (true);

drop policy if exists "authenticated read source checks" on source_checks;
create policy "authenticated read source checks"
on source_checks for select
to authenticated
using (true);

drop policy if exists "authenticated insert source checks" on source_checks;
create policy "authenticated insert source checks"
on source_checks for insert
to authenticated
with check (true);

drop policy if exists "authenticated update source checks" on source_checks;
create policy "authenticated update source checks"
on source_checks for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated delete source checks" on source_checks;
create policy "authenticated delete source checks"
on source_checks for delete
to authenticated
using (true);

drop function if exists is_ramirez_user();
