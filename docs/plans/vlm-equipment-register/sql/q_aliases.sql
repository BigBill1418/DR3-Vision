SELECT t.trailer_number AS tracking_value, COUNT(*) AS uses,
       e.unit AS candidate_equipment_unit, e.type AS candidate_type
FROM trailer_tracking_1 t
JOIN equipment e
  ON UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(t.trailer_number,' ',''),'#',''),'-',''),'O','0'),'I','1'))
   = UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.unit,' ',''),'#',''),'-',''),'O','0'),'I','1'))
 AND t.trailer_number <> e.unit
WHERE NOT EXISTS (SELECT 1 FROM equipment e2 WHERE e2.unit = t.trailer_number)
GROUP BY t.trailer_number, e.unit, e.type ORDER BY uses DESC;
